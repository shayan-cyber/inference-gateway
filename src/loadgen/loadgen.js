import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Histogram } from '../common/histogram.js';
import { makeRng } from '../common/rng.js';

/**
 * Open-loop load generator. Submits batches (or single requests) to the gateway at a
 * target request rate, independent of how fast the gateway completes them.
 *
 * opts: {
 *   gateway, rate (req/s), durationS, models: [{name, weight}], batchSize, tokens,
 *   tokenJitter (0..1, uniform +/-), payloadBytes, concurrency (max open HTTP calls),
 *   callbackUrl, mode: 'batch' | 'single', workers, idPrefix, includeIds, ttlMs, seed
 * }
 *
 * Every request the generator sends is counted as accepted (HTTP 202), rejected
 * (HTTP 429, the gateway's backpressure answer) or error (anything else).
 */
export const DEFAULT_LOAD = {
  gateway: 'http://127.0.0.1:8000',
  rate: 1000,
  durationS: 60,
  models: [{ name: 'model-a', weight: 1 }],
  batchSize: 100,
  tokens: 1000,
  tokenJitter: 0,
  payloadBytes: 64,
  concurrency: 64,
  callbackUrl: null,
  mode: 'batch',
  workers: 1,
  idPrefix: 'lg',
  includeIds: true,
  ttlMs: null,
  seed: 7,
};

export function parseModelMix(s) {
  if (!s) return DEFAULT_LOAD.models;
  return String(s).split(',').map((part) => {
    const [name, w] = part.split(':');
    return { name: name.trim(), weight: w === undefined ? 1 : Number(w) };
  });
}

async function generate(o, onSecond) {
  const url = new URL(o.gateway);
  const agent = new http.Agent({ keepAlive: true, maxSockets: o.concurrency, maxFreeSockets: o.concurrency });
  const rng = makeRng(o.seed + 1000 * (o.workerIndex || 0));
  const totalW = o.models.reduce((a, m) => a + m.weight, 0);
  const cum = [];
  let acc = 0;
  for (const m of o.models) { acc += m.weight / totalW; cum.push(acc); }
  const modelJson = o.models.map((m) => JSON.stringify(m.name));
  const payloadJson = o.payloadBytes > 0 ? `{"prompt":${JSON.stringify('x'.repeat(o.payloadBytes))}}` : null;
  const tail = (o.callbackUrl ? `,"callback_url":${JSON.stringify(o.callbackUrl)}` : '') + (o.ttlMs ? `,"ttl_ms":${o.ttlMs}` : '');
  let seq = 0;
  const idBase = `${o.idPrefix}-${o.workerIndex || 0}-`;

  const pickModel = () => {
    if (cum.length === 1) return 0;
    const r = rng.next();
    for (let k = 0; k < cum.length; k++) if (r < cum[k]) return k;
    return cum.length - 1;
  };
  const pickTokens = () => {
    if (!o.tokenJitter) return o.tokens;
    return Math.max(1, Math.round(o.tokens * (1 + o.tokenJitter * (2 * rng.next() - 1))));
  };
  const one = () => {
    let s = '{';
    if (o.includeIds) s += `"request_id":"${idBase}${seq++}",`;
    s += `"model":${modelJson[pickModel()]},"estimated_tokens":${pickTokens()}`;
    if (payloadJson) s += `,"payload":${payloadJson}`;
    return s;
  };
  const buildBatch = (n) => {
    let s = '{"requests":[';
    for (let i = 0; i < n; i++) s += (i ? ',' : '') + one() + '}';
    return `${s}]${tail}}`;
  };

  const st = {
    submitted: 0, accepted: 0, rejected: 0, errors: 0, batchesSent: 0, batchesAccepted: 0, batchesRejected: 0, shortfall: 0,
  };
  const ack = new Histogram();
  const perSec = new Map();
  const batchIds = [];
  const secRow = () => {
    const k = Math.floor(Date.now() / 1000);
    let r = perSec.get(k);
    if (!r) { r = [k * 1000, 0, 0, 0, 0]; perSec.set(k, r); }
    return r;
  };

  let open = 0;
  const path = o.mode === 'single' ? '/v1/requests' : '/v1/batches';
  const send = (n) => {
    const body = o.mode === 'single' ? `${one()}${tail}}` : buildBatch(n);
    st.submitted += n;
    st.batchesSent++;
    secRow()[1] += n;
    open++;
    const t0 = performance.now();
    const req = http.request({
      host: url.hostname, port: url.port, path, method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        open--;
        ack.record(performance.now() - t0);
        const row = secRow();
        if (res.statusCode === 202 || res.statusCode === 200) {
          // A batch may be partially accepted: requests for a congested model are
          // refused individually (reported in `rejected`).
          let rej = 0;
          let j = null;
          try { j = JSON.parse(Buffer.concat(chunks).toString()); rej = j.rejected || 0; } catch { /* ignore */ }
          st.accepted += n - rej; st.rejected += rej; st.batchesAccepted++; row[2] += n - rej; row[3] += rej;
          if (o.collectBatchIds && j) batchIds.push(j.batch_id || j.id);
        } else if (res.statusCode === 429) {
          st.rejected += n; st.batchesRejected++; row[3] += n;
        } else {
          st.errors += n; row[4] += n;
          if (st.errors <= n * 3) console.error(`[loadgen] HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`);
        }
      });
    });
    req.on('error', (e) => {
      open--;
      st.errors += n;
      secRow()[4] += n;
      if (st.errors <= n * 3) console.error(`[loadgen] ${e.message}`);
    });
    req.end(body);
  };

  const start = performance.now();
  const startedAt = Date.now();
  let lastReport = start;
  await new Promise((resolve) => {
    let sent = 0;
    const loop = () => {
      const now = performance.now();
      const el = (now - start) / 1000;
      if (el >= o.durationS) {
        const wait = () => (open === 0 ? resolve() : setTimeout(wait, 10));
        return wait();
      }
      let owed = Math.floor(o.rate * el) - sent;
      // If the client itself falls more than 2 s behind, don't try to catch up in a burst.
      const maxOwed = Math.max(o.batchSize, o.rate * 2);
      if (owed > maxOwed) { st.shortfall += owed - maxOwed; sent += owed - maxOwed; owed = maxOwed; }
      const unit = o.mode === 'single' ? 1 : o.batchSize;
      while (owed >= unit && open < o.concurrency) {
        send(unit);
        sent += unit;
        owed -= unit;
      }
      if (onSecond && now - lastReport >= 1000) { lastReport = now; onSecond({ ...st, open }); }
      setTimeout(loop, 2);
    };
    loop();
  });
  agent.destroy();
  return {
    ...st,
    startedAt,
    endedAt: Date.now(),
    ack: ack.toJSON(),
    perSecond: [...perSec.values()],
    batchIds,
  };
}

/** Runs the generator, across `workers` threads if > 1, and merges the results. */
export async function runLoad(userOpts, { onSecond } = {}) {
  const o = { ...DEFAULT_LOAD, ...userOpts };
  if (o.workers <= 1) {
    const r = await generate({ ...o, workerIndex: 0 }, onSecond);
    return finalize(o, [r]);
  }
  const file = fileURLToPath(import.meta.url);
  const live = new Array(o.workers).fill(null);
  const results = await Promise.all(Array.from({ length: o.workers }, (_, i) => new Promise((resolve, reject) => {
    const w = new Worker(file, {
      workerData: {
        ...o, rate: o.rate / o.workers, workerIndex: i, concurrency: Math.max(1, Math.ceil(o.concurrency / o.workers)), __loadgenWorker: true,
      },
    });
    w.on('message', (m) => {
      if (m.type === 'second') {
        live[i] = m.data;
        if (i === 0 && onSecond) {
          const agg = {};
          for (const d of live) if (d) for (const [k, v] of Object.entries(d)) agg[k] = (agg[k] || 0) + v;
          onSecond(agg);
        }
      } else if (m.type === 'done') resolve(m.data);
    });
    w.on('error', reject);
  })));
  return finalize(o, results);
}

function finalize(o, parts) {
  const sum = (k) => parts.reduce((a, p) => a + p[k], 0);
  const ack = new Histogram();
  for (const p of parts) ack.merge(p.ack);
  const perSec = new Map();
  for (const p of parts) {
    for (const r of p.perSecond) {
      const cur = perSec.get(r[0]);
      if (!cur) perSec.set(r[0], [...r]); else for (let i = 1; i < r.length; i++) cur[i] += r[i];
    }
  }
  const startedAt = Math.min(...parts.map((p) => p.startedAt));
  const endedAt = Math.max(...parts.map((p) => p.endedAt));
  const submitted = sum('submitted');
  return {
    options: { ...o, workerIndex: undefined },
    startedAt,
    endedAt,
    submitted,
    accepted: sum('accepted'),
    rejected: sum('rejected'),
    errors: sum('errors'),
    shortfall: sum('shortfall'),
    batchesSent: sum('batchesSent'),
    batchesAccepted: sum('batchesAccepted'),
    batchesRejected: sum('batchesRejected'),
    targetRate: o.rate,
    achievedSubmitRate: submitted / ((endedAt - startedAt) / 1000),
    ackLatencyMs: ack.summary(),
    perSecond: [...perSec.values()].sort((a, b) => a[0] - b[0]),
    perSecondFields: ['t', 'submitted', 'accepted', 'rejected', 'errors'],
    batchIds: parts.flatMap((p) => p.batchIds),
  };
}

if (!isMainThread && workerData && workerData.__loadgenWorker) {
  generate(workerData, (d) => parentPort.postMessage({ type: 'second', data: d }))
    .then((r) => parentPort.postMessage({ type: 'done', data: r }));
}
