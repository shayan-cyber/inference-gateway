import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Engine, SUCCEEDED, FAILED, EXPIRED, REJECTED,
} from '../gateway/engine.js';
import { InProcProvider } from '../gateway/provider-client.js';
import { ProviderSim } from '../tools/provider-sim/sim.js';
import { normalizeModel } from '../shared/models.js';
import { Histogram } from '../shared/histogram.js';
import { FrameReader, encodeCalls, decodeCalls, encodeResults, decodeResults } from '../shared/proto.js';

function makeEngine(modelOverrides = {}, options = {}) {
  const cfg = normalizeModel({
    name: 'm',
    rpm: 600_000,
    tpm: 1e12,
    latency: { distribution: 'fixed', median_ms: 5, min_ms: 1, max_ms: 10 },
    outcomes: { transient_error_rate: 0, permanent_error_rate: 0, timeout_rate: 0 },
    ...modelOverrides,
  });
  const sim = new ProviderSim({ models: [cfg] });
  const provider = new InProcProvider(sim);
  const engine = new Engine({
    models: [{ name: 'm', providerRpm: cfg.rpm, providerTpm: cfg.tpm }],
    provider,
    options: { retryBaseMs: 5, retryMaxMs: 20, ...options },
  });
  return { engine, sim };
}

async function runUntilDone(engine, b, maxMs = 10_000) {
  const t0 = Date.now();
  while (b.remaining > 0 && Date.now() - t0 < maxMs) {
    engine.tick();
    await new Promise((r) => setTimeout(r, 1));
  }
}

const batch = (n, extra = {}) => ({
  requests: Array.from({ length: n }, (_, i) => ({ request_id: `q${i}`, model: 'm', estimated_tokens: 100, payload: { i } })),
  ...extra,
});

test('a batch completes and every request reaches exactly one final state', async () => {
  const { engine } = makeEngine({ outcomes: { transient_error_rate: 0.3, permanent_error_rate: 0.1, timeout_rate: 0 } });
  const b = engine.submit(batch(2000), 'batch');
  await runUntilDone(engine, b);
  assert.equal(b.remaining, 0);
  assert.equal(b.counts[SUCCEEDED] + b.counts[FAILED] + b.counts[EXPIRED], 2000);
  const ids = new Set(engine.results(b, 0, 5000).results.map((r) => r.request_id));
  assert.equal(ids.size, 2000);
  assert.ok(b.counts[FAILED] > 100, 'permanent errors should fail requests');
  assert.ok(engine.totals.retried > 100, 'transient errors should be retried');
  assert.equal(engine.inflight.size, 0);
});

test('validation rejects bad input with 400s', () => {
  const { engine } = makeEngine();
  assert.throws(() => engine.submit({ requests: [] }, 'batch'), /non-empty/);
  assert.throws(() => engine.submit({ requests: [{ model: 'nope', estimated_tokens: 1 }] }, 'batch'), /not a configured model/);
  assert.throws(() => engine.submit({ requests: [{ model: 'm', estimated_tokens: 0 }] }, 'batch'), /positive integer/);
  assert.throws(() => engine.submit({ requests: [{ model: 'm', estimated_tokens: 1, request_id: 'a' }, { model: 'm', estimated_tokens: 1, request_id: 'a' }] }, 'batch'), /duplicated/);
  assert.throws(() => engine.submit({ requests: [{ model: 'm', estimated_tokens: 1 }], callback_url: 'ftp://x' }, 'batch'), /callback_url/);
});

test('admission control rejects with 429 once the backlog exceeds the max queue wait', () => {
  const { engine } = makeEngine({ rpm: 600 }, { maxQueueWaitMs: 1000 });
  engine.submit(batch(5), 'batch'); // empty queue: always accepted
  engine.submit(batch(5), 'batch'); // 5 queued at ~9.8/s -> ~0.5 s wait: accepted
  assert.throws(() => engine.submit(batch(5), 'batch'), (e) => e.status === 429);
  assert.equal(engine.totals.rejected, 5);
});

test('a congested model does not block other models in the same batch', () => {
  const mk = (name, rpm) => normalizeModel({
    name, rpm, tpm: 1e12, latency: { distribution: 'fixed', median_ms: 5 }, outcomes: { transient_error_rate: 0, permanent_error_rate: 0, timeout_rate: 0 },
  });
  const models = [mk('slow', 60), mk('fast', 600_000)];
  const engine = new Engine({
    models: models.map((m) => ({ name: m.name, providerRpm: m.rpm, providerTpm: m.tpm })),
    provider: new InProcProvider(new ProviderSim({ models })),
    options: { maxQueueWaitMs: 1000 },
  });
  const mixed = (n) => ({ requests: Array.from({ length: n }, (_, i) => ({ model: i % 2 ? 'fast' : 'slow', estimated_tokens: 10 })) });
  engine.submit(mixed(10), 'batch'); // slow now has a 5 s backlog
  const b = engine.submit(mixed(10), 'batch'); // slow's half is refused, fast's half accepted
  assert.equal(b.counts[REJECTED], 5);
  assert.equal(b.counts[0], 5); // queued
  assert.equal(b.remaining, 5);
  assert.equal(engine.results(b).results.filter((r) => r.error === 'model_over_capacity').length, 5);
  assert.throws(() => engine.submit({ ...mixed(10), admission: 'all_or_nothing' }, 'batch'), (e) => e.status === 429);
  assert.throws(() => engine.submit({ requests: [{ model: 'slow', estimated_tokens: 10 }] }, 'batch'), (e) => e.status === 429);
});

test('requests past their deadline expire instead of being sent', async () => {
  const { engine } = makeEngine({ rpm: 60 }); // 1 per second
  const b = engine.submit(batch(5, { ttl_ms: 1000 }), 'batch');
  await runUntilDone(engine, b, 3000);
  assert.equal(b.remaining, 0);
  assert.ok(b.counts[EXPIRED] >= 3, `expired=${b.counts[EXPIRED]}`);
});

test('histogram percentiles are within a few percent', () => {
  const h = new Histogram();
  for (let i = 1; i <= 10_000; i++) h.record(i);
  for (const [p, want] of [[50, 5000], [95, 9500], [99, 9900]]) {
    const got = h.percentile(p);
    assert.ok(Math.abs(got - want) / want < 0.04, `p${p}=${got}`);
  }
  const h2 = new Histogram().merge(h.toJSON()).merge(h);
  assert.equal(h2.n, 20_000);
});

test('binary protocol round-trips calls and results across chunk boundaries', () => {
  const ids = [1, 2, 4294967295]; const toks = [10, 20, 30]; const pays = ['{"a":1}', null, 'héllo'];
  const frame = Buffer.concat([encodeCalls(Buffer.from('model-x'), 3, ids, toks, pays), encodeResults([7, 0, 1234, 5, 8, 3, 0, 0], 2)]);
  const got = [];
  const reader = new FrameReader((buf, s) => {
    if (buf[s] === 1) {
      const scratch = { ids: new Uint32Array(1), toks: new Uint32Array(1) };
      const r = decodeCalls(buf, s, scratch);
      got.push(['calls', r.name, r.n, [...scratch.ids.slice(0, r.n)], [...scratch.toks.slice(0, r.n)]]);
    } else decodeResults(buf, s, (...x) => got.push(['res', ...x]));
  });
  for (let i = 0; i < frame.length; i += 5) reader.push(frame.subarray(i, i + 5));
  assert.deepEqual(got, [
    ['calls', 'model-x', 3, ids, toks],
    ['res', 7, 0, 1234, 5],
    ['res', 8, 3, 0, 0],
  ]);
});

test('in-flight table survives growth, collisions and bulk removal', async () => {
  const { InflightTable } = await import('../gateway/inflight.js');
  const t = new InflightTable(4);
  const live = new Map();
  for (let k = 0; k < 5000; k++) {
    const id = t.add('b', k, k);
    assert.ok(!live.has(id));
    live.set(id, k);
    if (k % 3 === 0) { // answer an older one
      const [oid, ok] = live.entries().next().value;
      assert.ok(t.take(oid, (b, i) => assert.equal(i, ok)));
      live.delete(oid);
    }
  }
  assert.equal(t.size, live.size);
  assert.equal(t.take(0xdeadbeef, () => {}), false);
  let removed = 0;
  t.removeWhere((b, i) => i % 2 === 0, () => { removed++; });
  assert.equal(t.size, live.size - removed);
  for (const [id, k] of live) assert.equal(t.take(id, () => {}), k % 2 === 1);
  assert.equal(t.size, 0);
});
