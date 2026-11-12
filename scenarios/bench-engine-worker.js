import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { Engine } from '../gateway/engine.js';
import { InProcProvider } from '../gateway/provider-client.js';
import { ProviderSim } from '../tools/provider-sim/sim.js';
import { normalizeModel } from '../shared/models.js';
import { MODEL_FIELDS } from '../gateway/engine.js';

/**
 * In-process engine benchmark shard: generator -> JSON.parse -> Engine.submit ->
 * limiter -> ProviderSim (per-call latency/outcome, timing wheel) -> Engine.onResult.
 * No sockets or HTTP. Measures what one engine shard + one simulator shard can
 * complete on one thread.
 */
const {
  index, shards, rate, durationS, batchSize, models: rawModels, payloadBytes, tokens,
} = workerData;

const models = rawModels.map((m) => normalizeModel(m));
const sim = new ProviderSim({ models, shardIndex: index, shardCount: shards, seed: 42 + index });
const provider = new InProcProvider(sim);
const engine = new Engine({
  shardId: index,
  shardCount: shards,
  models: models.map((m) => ({ name: m.name, providerRpm: m.rpm, providerTpm: m.tpm })),
  provider,
  options: { maxRetainedRequests: 50_000_000, resultRetentionMs: 600_000, maxDispatchPerTick: 100_000 },
});
engine.start();

const prompt = JSON.stringify('x'.repeat(payloadBytes));
let seq = 0;
function body(n) {
  let s = '{"requests":[';
  for (let i = 0; i < n; i++) {
    s += `${i ? ',' : ''}{"request_id":"e${index}-${seq++}","model":"${models[i & 1 ? 1 % models.length : 0].name}","estimated_tokens":${tokens},"payload":{"prompt":${prompt}}}`;
  }
  return `${s}]}`;
}

const start = performance.now();
const startedAt = Date.now();
let sent = 0; // pacing cursor (may skip ahead if this thread falls behind)
let submitted = 0; // requests actually submitted
let rejected = 0;
const tick = () => {
  const el = (performance.now() - start) / 1000;
  if (el >= durationS) return finish();
  let owed = Math.floor(rate * el) - sent;
  if (owed > rate) { sent += owed - rate; owed = rate; } // never burst more than 1 s behind
  let made = 0;
  while (owed >= batchSize && made < 20) {
    try {
      engine.submit(JSON.parse(body(batchSize)), 'batch', Date.now());
    } catch {
      rejected += batchSize;
    }
    submitted += batchSize;
    sent += batchSize;
    owed -= batchSize;
    made++;
  }
  return setTimeout(tick, 1);
};

function finish() {
  const endedAt = Date.now();
  const drainStart = Date.now();
  const wait = () => {
    const t = engine.totals;
    const waiting = t.accepted - t.succeeded - t.failed - t.expired;
    if (waiting > 0 && Date.now() - drainStart < 60_000) return setTimeout(wait, 50);
    engine.stop();
    const stats = engine.exportStats(0, true);
    return parentPort.postMessage({
      startedAt, endedAt, submitted, rejected, stats, fields: MODEL_FIELDS, simTotals: sim.metrics(Date.now()).totals,
    });
  };
  wait();
}
tick();
