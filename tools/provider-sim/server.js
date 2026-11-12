#!/usr/bin/env node
/**
 * Provider simulator.
 *
 *   node tools/provider-sim/server.js --config config/provider.default.json [--port 9000]
 *        [--shards 1] [--shard-base-port 9100] [--host 127.0.0.1] [--seed 42]
 *
 * Control API (HTTP, JSON):
 *   GET    /health
 *   GET    /v1/shards                 data-plane endpoints (binary TCP) for dispatchers
 *   GET    /v1/models                 configured models and limits
 *   POST   /v1/models                 add a model
 *   PATCH  /v1/models/:name           change limits / latency / outcomes live
 *   GET    /v1/metrics?since_ms=      per-model 100 ms series of accepted calls, tokens, 429s, outcomes
 *   POST   /v1/metrics/reset
 *   GET    /v1/limit-history          every limit in force, with the time it took effect
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  parseArgs, num, readJsonFile, readBody, sendJson,
} from '../../shared/util.js';
import { normalizeModel, modelToJson } from '../../shared/models.js';
import { mergeRows } from '../../shared/series.js';
import { PROVIDER_FIELDS, PROVIDER_BUCKET_MS } from './sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs();
const host = args.host || '127.0.0.1';
const port = num(args.port, 9000);
const shardCount = num(args.shards, 1);
const shardBasePort = num(args.shardBasePort, 9100);
const seed = num(args.seed, 42);
const configPath = args.config || path.join(here, '../../config/provider.default.json');

const cfg = readJsonFile(configPath);
const models = new Map();
const limitHistory = [];
const t0 = Date.now();
for (const raw of cfg.models) {
  const m = normalizeModel(raw);
  models.set(m.name, m);
  limitHistory.push({ t: t0, model: m.name, rpm: m.rpm, tpm: m.tpm });
}

const shards = [];
let nextReq = 1;
const pending = new Map();

function ask(w, msg) {
  return new Promise((resolve, reject) => {
    const id = nextReq++;
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id });
  });
}

async function startShards() {
  const readies = [];
  for (let i = 0; i < shardCount; i++) {
    const w = new Worker(path.join(here, 'shard-worker.js'), {
      workerData: {
        host, port: shardBasePort + i, shardIndex: i, shardCount, models: [...models.values()], seed,
      },
    });
    readies.push(new Promise((resolve, reject) => {
      w.on('message', (msg) => {
        if (msg.type === 'ready') resolve();
        else if (msg.type === 'reply') {
          const p = pending.get(msg.id);
          if (p) { pending.delete(msg.id); p.resolve(msg.data); }
        }
      });
      w.on('error', (e) => { console.error(`[provider] shard ${i} error`, e); reject(e); });
    }));
    w.on('exit', (code) => { if (code !== 0) { console.error(`[provider] shard ${i} exited ${code}`); process.exit(1); } });
    shards.push({ worker: w, index: i, port: shardBasePort + i });
  }
  await Promise.all(readies);
}

function broadcastModel(m) {
  for (const s of shards) s.worker.postMessage({ type: 'upsert_model', model: m });
}

async function collectMetrics(sinceMs) {
  const parts = await Promise.all(shards.map((s) => ask(s.worker, { type: 'metrics', sinceMs })));
  const out = {};
  const totals = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.totals)) totals[k] = (totals[k] || 0) + v;
  }
  for (const name of models.keys()) {
    out[name] = mergeRows(parts.map((p) => p.models[name] || []), PROVIDER_FIELDS.length);
  }
  return {
    now: Date.now(),
    bucket_ms: PROVIDER_BUCKET_MS,
    fields: ['t', ...PROVIDER_FIELDS],
    shards: shardCount,
    models: out,
    totals,
    limit_history: limitHistory,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, pid: process.pid, shards: shardCount, uptime_s: Math.round(process.uptime()) });
    }
    if (parts[0] !== 'v1') return sendJson(res, 404, { error: 'not_found' });
    if (req.method === 'GET' && parts[1] === 'shards') {
      return sendJson(res, 200, { count: shardCount, shards: shards.map((s) => ({ index: s.index, host, port: s.port })) });
    }
    if (parts[1] === 'models') {
      if (req.method === 'GET' && parts.length === 2) {
        return sendJson(res, 200, { models: [...models.values()].map(modelToJson) });
      }
      if (req.method === 'GET' && parts.length === 3) {
        const m = models.get(decodeURIComponent(parts[2]));
        return m ? sendJson(res, 200, modelToJson(m)) : sendJson(res, 404, { error: 'unknown_model' });
      }
      if (req.method === 'POST' && parts.length === 2) {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (models.has(body.name)) return sendJson(res, 409, { error: 'model_exists' });
        const m = normalizeModel(body);
        models.set(m.name, m);
        limitHistory.push({ t: Date.now(), model: m.name, rpm: m.rpm, tpm: m.tpm });
        broadcastModel(m);
        console.log(`[provider] added model ${m.name} rpm=${m.rpm} tpm=${m.tpm}`);
        return sendJson(res, 201, modelToJson(m));
      }
      if ((req.method === 'PATCH' || req.method === 'PUT') && parts.length === 3) {
        const name = decodeURIComponent(parts[2]);
        const cur = models.get(name);
        if (!cur) return sendJson(res, 404, { error: 'unknown_model' });
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const m = normalizeModel({ ...body, name }, cur);
        models.set(name, m);
        if (m.rpm !== cur.rpm || m.tpm !== cur.tpm) limitHistory.push({ t: Date.now(), model: name, rpm: m.rpm, tpm: m.tpm });
        broadcastModel(m);
        console.log(`[provider] updated ${name}: rpm=${m.rpm} tpm=${m.tpm}`);
        return sendJson(res, 200, modelToJson(m));
      }
    }
    if (parts[1] === 'metrics') {
      if (req.method === 'GET' && parts.length === 2) {
        const since = num(url.searchParams.get('since_ms'), 0);
        return sendJson(res, 200, await collectMetrics(since));
      }
      if (req.method === 'POST' && parts[2] === 'reset') {
        await Promise.all(shards.map((s) => ask(s.worker, { type: 'reset_metrics' })));
        return sendJson(res, 200, { ok: true });
      }
    }
    if (req.method === 'GET' && parts[1] === 'limit-history') return sendJson(res, 200, { limit_history: limitHistory });
    return sendJson(res, 404, { error: 'not_found' });
  } catch (e) {
    return sendJson(res, e.status || 400, { error: 'bad_request', message: e.message });
  }
});

await startShards();
server.listen(port, host, () => {
  console.log(`[provider] control API http://${host}:${port}  shards=${shardCount} (tcp ${shardBasePort}..${shardBasePort + shardCount - 1})`);
  for (const m of models.values()) console.log(`[provider]   ${m.name}: rpm=${m.rpm} tpm=${m.tpm} latency=${m.latency.distribution} p50=${m.latency.medianMs}ms`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
