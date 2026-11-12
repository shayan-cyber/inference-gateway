#!/usr/bin/env node
/**
 * Throughput benchmarks (simulated provider, very high limits).
 *
 *   node scenarios/bench.js --mode e2e    --rate 300000  --duration 30 [--gateway-shards 4] [--provider-shards 4] [--loadgen-workers 4] [--batch-size 5000]
 *   node scenarios/bench.js --mode engine --rate 1000000 --duration 20 [--shards 12] [--batch-size 2000]
 *
 * e2e:    load generator --HTTP/JSON--> gateway (main thread + engine shards) --binary TCP--> provider simulator shards.
 *         Three OS processes; this is the full system.
 * engine: engine shards with the simulator in the same thread (no HTTP, no sockets);
 *         isolates the engine's own capacity. The request bodies are still JSON
 *         strings parsed per batch, as the API path would.
 *
 * A request counts as completed only when its simulated provider call reached a final
 * success/failure state and the engine recorded it.
 */
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, num, fetchJson, fmtInt, round, readJsonFile, bool,
} from '../shared/util.js';
import { runLoad } from '../tools/loadgen/loadgen.js';
import { Histogram } from '../shared/histogram.js';
import { mergeRows } from '../shared/series.js';
import { MODEL_FIELDS, MODEL_FIELD_MERGE } from '../gateway/engine.js';
import {
  lineChart, writeReport, mdTable, environment,
} from '../tools/report/render.js';
import { gatewayCompletions } from '../tools/report/analyze.js';
import {
  startStack, waitForDrain, envMarkdown, reportDir, logProgress, ROOT,
} from './lib.js';

const a = parseArgs();
const mode = a.mode || 'e2e';
const rate = num(a.rate, 300_000);
const durationS = num(a.duration, 30);
const batchSize = num(a.batchSize, mode === 'e2e' ? 5000 : 2000);
const payloadBytes = num(a.payloadBytes, 32);
const tokens = num(a.tokens, 500);
const label = a.label || `${mode}-${rate >= 1e6 ? `${rate / 1e6}m` : `${rate / 1e3}k`}`;
const outDir = a.out ? path.resolve(a.out) : reportDir(`bench-${label}`);
const here = path.dirname(fileURLToPath(import.meta.url));
const providerCfg = readJsonFile(path.join(ROOT, 'config/bench.provider.json'));

/** Steady window: skip the first `head` and last `tail` seconds of submission. */
function steadyStats(comp, startedAt, endedAt, head = 3, tail = 2) {
  const from = startedAt + head * 1000;
  const to = endedAt - tail * 1000;
  const rows = comp.filter((r) => r[0] >= from && r[0] + 1000 <= to);
  const total = rows.reduce((s, r) => s + r[1], 0);
  const peak = Math.max(0, ...comp.map((r) => r[1]));
  const sorted = rows.map((r) => r[1]).sort((x, y) => x - y);
  return {
    seconds: rows.length,
    mean_per_s: rows.length ? total / rows.length : 0,
    min_per_s: sorted[0] ?? 0,
    median_per_s: sorted[Math.floor(sorted.length / 2)] ?? 0,
    peak_per_s: peak,
  };
}

async function benchE2E() {
  const P = num(a.providerShards, 4);
  const E = num(a.gatewayShards, 4);
  const W = num(a.loadgenWorkers, 4);
  console.log(`bench e2e: target ${fmtInt(rate)} req/s for ${durationS}s, batch ${batchSize}, provider shards ${P}, gateway shards ${E}, loadgen workers ${W}`);
  const stack = await startStack({
    providerConfig: 'config/bench.provider.json',
    providerShards: P,
    gatewayShards: E,
    logDir: path.join(outDir, 'logs'),
    gatewayArgs: ['--max-retained-requests', String(Math.max(20_000_000, rate * durationS * 1.2)), '--limit-sync-ms', '0'],
  });
  try {
    const t0 = Date.now();
    const load = await runLoad({
      gateway: stack.gatewayUrl,
      rate,
      durationS,
      batchSize,
      tokens,
      payloadBytes,
      models: [{ name: 'model-a', weight: 1 }, { name: 'model-b', weight: 1 }],
      concurrency: num(a.concurrency, 16 * W),
      workers: W,
      includeIds: bool(a.ids, true),
    }, { onSecond: logProgress('load', t0) });
    console.log('');
    const drain = await waitForDrain(stack.gatewayUrl, 120_000);
    console.log('');
    const final = await fetchJson(`${stack.gatewayUrl}/v1/stats?series=1`);
    const prov = await fetchJson(`${stack.providerUrl}/v1/metrics?since_ms=${Date.now() + 1e9}`);
    const comp = gatewayCompletions(final);
    const steady = steadyStats(comp, load.startedAt, load.endedAt);
    return {
      mode: 'e2e',
      config: {
        rate, durationS, batchSize, tokens, payloadBytes, provider_shards: P, gateway_shards: E, loadgen_workers: W,
      },
      load: { ...load, batchIds: undefined, perSecond: undefined },
      drain,
      totals: final.totals,
      latency_ms: final.latency_ms,
      provider_totals: prov.totals,
      steady,
      comp,
      startedAt: load.startedAt,
      endedAt: load.endedAt,
      submitted: load.submitted,
      accepted: load.accepted,
      rejected: load.rejected + load.errors,
    };
  } finally {
    await stack.stop();
  }
}

async function benchEngine() {
  const S = num(a.shards, 8);
  console.log(`bench engine (in-process): target ${fmtInt(rate)} req/s for ${durationS}s over ${S} engine+simulator threads, batch ${batchSize}`);
  const parts = await Promise.all(Array.from({ length: S }, (_, i) => new Promise((resolve, reject) => {
    const w = new Worker(path.join(here, 'bench-engine-worker.js'), {
      workerData: {
        index: i, shards: S, rate: rate / S, durationS, batchSize, models: providerCfg.models, payloadBytes, tokens,
      },
    });
    w.on('message', resolve);
    w.on('error', reject);
  })));
  const totals = {};
  for (const p of parts) for (const [k, v] of Object.entries(p.stats.totals)) totals[k] = (totals[k] || 0) + v;
  totals.completed = totals.succeeded + totals.failed;
  totals.waiting = totals.accepted - totals.succeeded - totals.failed - totals.expired;
  const e2e = new Histogram(); const rtt = new Histogram();
  for (const p of parts) { e2e.merge(p.stats.hist.e2e); rtt.merge(p.stats.hist.rtt); }
  const models = {};
  for (const name of Object.keys(parts[0].stats.models)) {
    models[name] = { series: mergeRows(parts.map((p) => p.stats.models[name].series), MODEL_FIELDS.length, MODEL_FIELD_MERGE) };
  }
  const comp = gatewayCompletions({ series_fields: ['t', ...MODEL_FIELDS], models });
  const startedAt = Math.min(...parts.map((p) => p.startedAt));
  const endedAt = Math.max(...parts.map((p) => p.endedAt));
  return {
    mode: 'engine',
    config: {
      rate, durationS, batchSize, tokens, payloadBytes, shards: S,
    },
    totals,
    latency_ms: { end_to_end: e2e.summary(), provider_round_trip: rtt.summary() },
    steady: steadyStats(comp, startedAt, endedAt),
    comp,
    startedAt,
    endedAt,
    submitted: parts.reduce((s, p) => s + p.submitted, 0),
    accepted: totals.accepted,
    rejected: parts.reduce((s, p) => s + p.rejected, 0),
  };
}

const r = mode === 'engine' ? await benchEngine() : await benchE2E();
const T = r.totals;
const balanced = r.submitted === T.completed + T.expired + T.waiting + r.rejected;
const env = environment();
const xs = (t) => (t - r.startedAt) / 1000;
const charts = [{
  title: 'Completions per second',
  svg: lineChart({
    title: `${mode}: requests completed per second (final provider outcome recorded) vs target`,
    yLabel: 'req/s',
    series: [
      { name: 'completed/s', points: r.comp.map((p) => [xs(p[0]), p[1]]) },
      { name: 'dispatched/s', points: r.comp.map((p) => [xs(p[0]), p[5]]), color: '#9333ea', width: 1 },
      { name: 'target', points: [[0, rate], [r.config.durationS, rate]], color: '#dc2626', dash: '6 4' },
    ],
  }),
}];
const subRate = r.submitted / ((r.endedAt - r.startedAt) / 1000);
const md = [
  `# Benchmark: ${mode === 'e2e' ? 'end-to-end (HTTP -> gateway -> TCP -> provider simulator)' : 'engine + simulator in-process'} @ ${fmtInt(rate)} req/s target`,
  '',
  `Generated ${new Date().toISOString()} by \`node scenarios/bench.js ${process.argv.slice(2).join(' ')}\``,
  '',
  '## Measured',
  mdTable(['metric', 'value'], [
    ['target submit rate (req/s)', fmtInt(rate)],
    ['achieved submit rate (req/s)', fmtInt(subRate)],
    ['steady completion rate, mean (req/s)', `**${fmtInt(r.steady.mean_per_s)}**`],
    ['steady completion rate, median / min 1 s (req/s)', `${fmtInt(r.steady.median_per_s)} / ${fmtInt(r.steady.min_per_s)}`],
    ['peak 1 s completions', fmtInt(r.steady.peak_per_s)],
    ['steady window (s)', r.steady.seconds],
    ['submitted', fmtInt(r.submitted)],
    ['accepted / rejected', `${fmtInt(r.accepted)} / ${fmtInt(r.rejected)}`],
    ['completed (succeeded + failed)', `${fmtInt(T.completed)} (${fmtInt(T.succeeded)} + ${fmtInt(T.failed)})`],
    ['expired / still waiting', `${fmtInt(T.expired)} / ${fmtInt(T.waiting)}`],
    ['accounting balanced', balanced ? 'yes' : 'NO'],
    ['retry attempts', fmtInt(T.retried)],
    ['end-to-end latency p50 / p95 / p99 (ms)', `${r.latency_ms.end_to_end.p50} / ${r.latency_ms.end_to_end.p95} / ${r.latency_ms.end_to_end.p99}`],
    ['provider round trip p50 / p95 / p99 (ms)', `${r.latency_ms.provider_round_trip.p50} / ${r.latency_ms.provider_round_trip.p95} / ${r.latency_ms.provider_round_trip.p99}`],
    ...(r.load ? [['API ack latency p50 / p99 (ms)', `${r.load.ackLatencyMs.p50} / ${r.load.ackLatencyMs.p99}`]] : []),
  ]),
  '',
  '## Configuration',
  mdTable(['setting', 'value'], Object.entries(r.config).map(([k, v]) => [k, v])),
  '',
  'Simulated models: model-a (latency p50 50 ms / p99 250 ms), model-b (p50 80 ms / p99 400 ms), 0.1% transient + 0.05% permanent errors, limits raised to 60B RPM so they do not bind. Traffic split 50/50.',
  '',
  '## Environment',
  envMarkdown(env),
].join('\n');
writeReport(outDir, {
  title: `bench ${label}`, markdown: md, charts, json: { ...r, environment: env },
});
console.log(`\n${md.split('## Configuration')[0]}`);
console.log(`report: ${path.relative(ROOT, outDir)}/report.md`);
