#!/usr/bin/env node
/**
 * Inference gateway.
 *
 *   node src/gateway/server.js [--port 8000] [--provider http://127.0.0.1:9000] [--shards 1]
 *        [--config config/gateway.default.json] [--limit-sync-ms 1000]
 *
 * The main thread terminates HTTP and routes; each engine shard runs on its own
 * worker thread with its own queues, limiter share and provider connection.
 *
 * Public API:
 *   POST /v1/requests[?wait=true]      one request  {model, payload, estimated_tokens, request_id?, ttl_ms?, max_attempts?}
 *   POST /inference                    alias of POST /v1/requests (drop-in for the original loop)
 *   GET  /v1/requests/:id
 *   POST /v1/batches                   {requests:[...], callback_url?, ttl_ms?, max_attempts?, metadata?} -> 202 {batch_id}
 *   GET  /v1/batches/:id               status summary (+ callback delivery state)
 *   GET  /v1/batches/:id/results?offset=&limit=
 *   GET  /v1/models                    limits (provider, operator cap, effective), queue depth, observed rate
 *   PUT  /v1/models/:name/limits       operator cap {rpm?, tpm?}; null clears. Effective = min(provider, cap)
 *   GET  /v1/stats[?series=1&since_ms=]
 *   GET  /v1/limit-history
 *   GET  /                             live dashboard
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  parseArgs, num, readJsonFile, readBody, sendJson, fetchJson, sleep, round,
} from '../common/util.js';
import { Histogram } from '../common/histogram.js';
import { mergeRows } from '../common/series.js';
import { MODEL_FIELDS, MODEL_FIELD_MERGE, DEFAULT_ENGINE_OPTIONS } from './engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs();
const host = args.host || '127.0.0.1';
const port = num(args.port, 8000);
const providerUrl = (args.provider || 'http://127.0.0.1:9000').replace(/\/$/, '');
const shardCount = num(args.shards, 1);
const limitSyncMs = num(args.limitSyncMs, 1000);
const fileCfg = args.config ? readJsonFile(args.config) : {};
const options = {
  ...DEFAULT_ENGINE_OPTIONS,
  ...(fileCfg.engine || {}),
  callback: { ...DEFAULT_ENGINE_OPTIONS.callback, ...((fileCfg.engine || {}).callback || {}) },
};
for (const k of ['maxQueueWaitMs', 'defaultTtlMs', 'maxAttempts', 'maxBatchSize', 'resultRetentionMs', 'maxRetainedRequests', 'utilization']) {
  if (args[k] !== undefined) options[k] = num(args[k]);
}
if (args.callbackBaseDelayMs) options.callback.baseDelayMs = num(args.callbackBaseDelayMs);
options.publicBaseUrl = args.publicBaseUrl || `http://${host}:${port}`;
options.maxRetainedRequests = Math.ceil(options.maxRetainedRequests / shardCount);

const models = new Map(); // name -> { providerRpm, providerTpm, capRpm, capTpm }
const limitHistory = [];
const workers = [];
const pending = new Map();
let nextReq = 1;
let rr = 0;
const startedAt = Date.now();

function effective(m) {
  return { rpm: Math.min(m.providerRpm, m.capRpm ?? Infinity), tpm: Math.min(m.providerTpm, m.capTpm ?? Infinity) };
}

function recordLimit(name, source) {
  const m = models.get(name);
  const e = effective(m);
  limitHistory.push({
    t: Date.now(), model: name, source, rpm: e.rpm, tpm: e.tpm, provider_rpm: m.providerRpm, provider_tpm: m.providerTpm, cap_rpm: m.capRpm ?? null, cap_tpm: m.capTpm ?? null,
  });
}

function modelMsg(name) {
  const m = models.get(name);
  return {
    name, providerRpm: m.providerRpm, providerTpm: m.providerTpm, capRpm: m.capRpm ?? Infinity, capTpm: m.capTpm ?? Infinity,
  };
}

function broadcast(name) {
  const msg = { type: 'upsert_model', model: modelMsg(name) };
  for (const w of workers) w.postMessage(msg);
}

function ask(w, msg) {
  return new Promise((resolve) => {
    const id = nextReq++;
    pending.set(id, resolve);
    w.postMessage({ ...msg, id });
  });
}

// ---- provider discovery & limit sync ------------------------------------------------

async function waitForProvider() {
  for (let i = 0; i < 120; i++) {
    try { return await fetchJson(`${providerUrl}/health`, { timeoutMs: 1000 }); } catch { await sleep(250); }
  }
  throw new Error(`provider not reachable at ${providerUrl}`);
}

let syncing = false;
let syncSoon = null;
async function syncLimits(reason = 'poll') {
  if (syncing) return;
  syncing = true;
  try {
    const r = await fetchJson(`${providerUrl}/v1/models`, { timeoutMs: 2000 });
    for (const pm of r.models) {
      const cur = models.get(pm.name);
      if (!cur) {
        models.set(pm.name, { providerRpm: pm.rpm, providerTpm: pm.tpm, capRpm: null, capTpm: null });
        recordLimit(pm.name, `provider:${reason}`);
        broadcast(pm.name);
        console.log(`[gateway] discovered model ${pm.name} rpm=${pm.rpm} tpm=${pm.tpm}`);
      } else if (cur.providerRpm !== pm.rpm || cur.providerTpm !== pm.tpm) {
        cur.providerRpm = pm.rpm;
        cur.providerTpm = pm.tpm;
        recordLimit(pm.name, `provider:${reason}`);
        broadcast(pm.name);
        console.log(`[gateway] provider limits changed for ${pm.name}: rpm=${pm.rpm} tpm=${pm.tpm} (via ${reason})`);
      }
    }
  } catch (e) {
    if (reason === 'poll') console.warn(`[gateway] limit sync failed: ${e.message}`);
  } finally {
    syncing = false;
  }
}

function onWorkerEvent(ev) {
  if (ev.type === 'rate_limited' && !syncSoon) {
    // A 429 means our view of the limits may be stale: re-read them now.
    syncSoon = setTimeout(() => { syncSoon = null; syncLimits('429'); }, 50);
  }
}

// ---- stats aggregation --------------------------------------------------------------

async function aggregateStats(sinceMs, withSeries) {
  const parts = await Promise.all(workers.map((w) => ask(w, { type: 'stats', sinceMs, series: withSeries })));
  const totals = {};
  for (const p of parts) for (const [k, v] of Object.entries(p.totals)) totals[k] = (totals[k] || 0) + v;
  totals.waiting = totals.accepted - totals.succeeded - totals.failed - totals.expired;
  totals.completed = totals.succeeded + totals.failed;
  const hist = {};
  for (const k of Object.keys(parts[0].hist)) {
    const h = new Histogram();
    for (const p of parts) h.merge(p.hist[k]);
    hist[k] = h.summary();
  }
  const now = Date.now();
  const modelsOut = {};
  for (const [name, m] of models) {
    const e = effective(m);
    const h = new Histogram();
    let qd = 0; let inf = 0; let wReq = 0; let wTok = 0; let paused = false;
    const rowSets = [];
    for (const p of parts) {
      const pm = p.models[name];
      if (!pm) continue;
      h.merge(pm.hist);
      qd += pm.queue_depth; inf += pm.inflight; wReq += pm.window.requests; wTok += pm.window.tokens;
      paused = paused || pm.paused;
      if (pm.series) rowSets.push(pm.series);
    }
    modelsOut[name] = {
      limits: {
        provider_rpm: m.providerRpm,
        provider_tpm: m.providerTpm,
        cap_rpm: m.capRpm ?? null,
        cap_tpm: m.capTpm ?? null,
        effective_rpm: e.rpm,
        effective_tpm: e.tpm,
      },
      queue_depth: qd,
      inflight: inf,
      paused_after_429: paused,
      dispatched_last_60s: { requests: wReq, tokens: wTok },
      utilization_last_60s: { rpm: e.rpm ? round(wReq / e.rpm, 4) : null, tpm: e.tpm ? round(wTok / e.tpm, 4) : null },
      latency_ms: h.summary(),
      series: withSeries ? mergeRows(rowSets, MODEL_FIELDS.length, MODEL_FIELD_MERGE) : undefined,
    };
  }
  return {
    now,
    started_at: new Date(startedAt).toISOString(),
    pid: process.pid,
    shards: shardCount,
    totals,
    latency_ms: { end_to_end: hist.e2e, provider_round_trip: hist.rtt },
    batches: {
      accepted: totals.batchesAccepted,
      rejected: totals.batchesRejected,
      completed: totals.batchesCompleted,
      completion_time_ms: hist.batch,
      callback_first_attempt_delay_ms: hist.callbackFirst,
      callback_delivered_delay_ms: hist.callback,
      callbacks: {
        delivered: totals.callbacksDelivered, failed: totals.callbacksFailed, attempts: totals.callbackAttempts, pending: totals.callbacksPending,
      },
    },
    series_fields: withSeries ? ['t', ...MODEL_FIELDS] : undefined,
    models: modelsOut,
  };
}

// ---- HTTP ---------------------------------------------------------------------------

function shardOf(id) {
  const us = id.indexOf('_');
  const s = us > 1 ? Number.parseInt(id.slice(1, us), 10) : NaN;
  return Number.isInteger(s) && s >= 0 && s < workers.length ? workers[s] : null;
}

function forward(res, w, msg) {
  const id = nextReq++;
  pending.set(id, (r) => {
    res.writeHead(r.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(r.body), ...(r.headers || {}) });
    res.end(r.body);
  });
  w.postMessage({ ...msg, id });
}

const dashboardPath = path.join(here, 'dashboard.html');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const parts = p.split('/').filter(Boolean);

    if (req.method === 'GET' && (p === '/' || p === '/dashboard')) {
      const html = fs.readFileSync(dashboardPath);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length });
      return res.end(html);
    }
    if (req.method === 'GET' && (p === '/healthz' || p === '/health')) {
      return sendJson(res, 200, {
        ok: true, pid: process.pid, shards: shardCount, uptime_s: Math.round(process.uptime()), provider: providerUrl,
      });
    }
    if (req.method === 'POST' && (p === '/v1/requests' || p === '/inference')) {
      const body = await readBody(req);
      const wait = url.searchParams.get('wait');
      return forward(res, workers[rr++ % workers.length], {
        type: 'submit', kind: 'single', body, wait: wait === 'true' || wait === '1', waitMs: num(url.searchParams.get('wait_ms'), 30_000),
      });
    }
    if (req.method === 'POST' && p === '/v1/batches') {
      const body = await readBody(req);
      return forward(res, workers[rr++ % workers.length], { type: 'submit', kind: 'batch', body });
    }
    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'batches' && parts[2]) {
      const w = shardOf(parts[2]);
      if (!w) return sendJson(res, 404, { error: 'not_found', message: 'batch not found' });
      if (parts[3] === 'results') {
        return forward(res, w, {
          type: 'get_results', batchId: parts[2], offset: num(url.searchParams.get('offset'), 0), limit: num(url.searchParams.get('limit'), 10_000),
        });
      }
      return forward(res, w, { type: 'get_batch', batchId: parts[2] });
    }
    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'requests' && parts[2]) {
      const w = shardOf(parts[2]);
      if (!w) return sendJson(res, 404, { error: 'not_found', message: 'request not found' });
      return forward(res, w, { type: 'get_request', requestId: parts[2] });
    }
    if (req.method === 'GET' && p === '/v1/models') {
      const s = await aggregateStats(0, false);
      return sendJson(res, 200, { models: Object.entries(s.models).map(([name, m]) => ({ name, ...m })) });
    }
    if ((req.method === 'PUT' || req.method === 'PATCH') && parts[0] === 'v1' && parts[1] === 'models' && parts[3] === 'limits') {
      const name = decodeURIComponent(parts[2]);
      const m = models.get(name);
      if (!m) return sendJson(res, 404, { error: 'unknown_model' });
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      for (const [k, key] of [['rpm', 'capRpm'], ['tpm', 'capTpm']]) {
        if (!(k in body)) continue;
        const v = body[k];
        if (v !== null && !(Number.isFinite(v) && v >= 0)) return sendJson(res, 400, { error: 'invalid_limit', message: `${k} must be a non-negative number or null` });
        m[key] = v;
      }
      recordLimit(name, 'operator');
      broadcast(name);
      console.log(`[gateway] operator cap for ${name}: rpm=${m.capRpm ?? '-'} tpm=${m.capTpm ?? '-'} -> effective ${JSON.stringify(effective(m))}`);
      return sendJson(res, 200, {
        name, provider_rpm: m.providerRpm, provider_tpm: m.providerTpm, cap_rpm: m.capRpm ?? null, cap_tpm: m.capTpm ?? null, effective: effective(m),
      });
    }
    if (req.method === 'GET' && p === '/v1/stats') {
      const series = url.searchParams.get('series');
      return sendJson(res, 200, await aggregateStats(num(url.searchParams.get('since_ms'), 0), series === '1' || series === 'true'));
    }
    if (req.method === 'GET' && p === '/v1/limit-history') return sendJson(res, 200, { limit_history: limitHistory });
    return sendJson(res, 404, { error: 'not_found' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, e.status || 400, { error: 'bad_request', message: e.message });
  }
});
server.keepAliveTimeout = 65_000;
server.requestTimeout = 0;

// ---- boot -----------------------------------------------------------------------------

await waitForProvider();
const shardInfo = await fetchJson(`${providerUrl}/v1/shards`);
const P = shardInfo.count;
if (shardCount % P !== 0) {
  console.error(`[gateway] --shards (${shardCount}) must be a multiple of the provider shard count (${P}) so limit shares line up`);
  process.exit(1);
}
const initial = await fetchJson(`${providerUrl}/v1/models`);
for (const pm of initial.models) {
  const caps = (fileCfg.caps || {})[pm.name] || {};
  models.set(pm.name, {
    providerRpm: pm.rpm, providerTpm: pm.tpm, capRpm: caps.rpm ?? null, capTpm: caps.tpm ?? null,
  });
  recordLimit(pm.name, 'startup');
}

for (let i = 0; i < shardCount; i++) {
  const ps = shardInfo.shards[i % P];
  const w = new Worker(path.join(here, 'engine-worker.js'), {
    workerData: {
      shardId: i,
      shardCount,
      provider: { host: ps.host, port: ps.port },
      models: [...models.keys()].map(modelMsg),
      options,
    },
  });
  w.on('message', (msg) => {
    if (msg.type === 'reply' || msg.type === 'data') {
      const cb = pending.get(msg.id);
      if (cb) { pending.delete(msg.id); cb(msg.type === 'data' ? msg.data : msg); }
    } else if (msg.type === 'event') onWorkerEvent(msg);
  });
  w.on('error', (e) => { console.error(`[gateway] shard ${i} crashed`, e); process.exit(1); });
  workers.push(w);
}

if (limitSyncMs > 0) setInterval(() => syncLimits('poll'), limitSyncMs).unref();

server.listen(port, host, () => {
  console.log(`[gateway] listening on http://${host}:${port}  shards=${shardCount}  provider=${providerUrl} (${P} shard(s))  cpus=${os.cpus().length}`);
  for (const [name, m] of models) console.log(`[gateway]   ${name}: rpm=${m.providerRpm} tpm=${m.providerTpm}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
