#!/usr/bin/env node
/**
 * Scenario 1: reach the available provider capacity.
 *
 * model-a = 50,000 RPM / 100M TPM. Submit 1,000-token requests above capacity
 * (default 1,000 req/s = 60,000 RPM, 120% of the limit) for 5 minutes.
 *
 * Pass when:
 *   - completions after warm-up >= 90% of the allowed request rate
 *   - no 60 s period at the provider exceeds 50,000 requests or 100M tokens
 *   - every submitted request is completed, waiting, expired or rejected
 *
 *   node scenarios/scenario1.js [--duration 300] [--rate 1000] [--batch-size 100] [--warmup 60]
 */
import path from 'node:path';
import {
  parseArgs, num, fetchJson, fmtInt, round,
} from '../shared/util.js';
import { runLoad } from '../tools/loadgen/loadgen.js';
import { lineChart, writeReport, mdTable } from '../tools/report/render.js';
import { seriesFor } from '../tools/report/analyze.js';
import {
  startStack, waitForDrain, summarizeRun, summaryMarkdown, envMarkdown, reportDir, logProgress, pass, ROOT,
} from './lib.js';

const a = parseArgs();
const durationS = num(a.duration, 300);
const rate = num(a.rate, 1000);
const batchSize = num(a.batchSize, 100);
const warmupS = num(a.warmup, 60);
const RPM = 50_000;
const TPM = 100_000_000;
const outDir = a.out ? path.resolve(a.out) : reportDir('scenario1');

console.log(`Scenario 1: ${rate} req/s (${round((rate * 60 * 100) / RPM, 1)}% of ${fmtInt(RPM)} RPM) for ${durationS}s, batches of ${batchSize}, 1000 tokens each`);
const stack = await startStack({ providerConfig: 'config/scenario1.provider.json', logDir: path.join(outDir, 'logs') });
try {
  const t0 = Date.now();
  const load = await runLoad({
    gateway: stack.gatewayUrl, rate, durationS, batchSize, tokens: 1000, models: [{ name: 'model-a', weight: 1 }], concurrency: 64,
  }, { onSecond: logProgress('load', t0) });
  const atEnd = await fetchJson(`${stack.gatewayUrl}/v1/stats`);
  console.log(`\n  submission finished; waiting=${fmtInt(atEnd.totals.waiting)}; draining...`);
  const drain = await waitForDrain(stack.gatewayUrl, num(a.drainTimeout, 180_000));
  const final = await fetchJson(`${stack.gatewayUrl}/v1/stats?series=1`);
  const prov = await fetchJson(`${stack.providerUrl}/v1/metrics`);
  const s = summarizeRun({
    load, atSubmitEnd: atEnd, finalStats: final, provider: prov, warmupS,
  });
  const m = s.models['model-a'];
  const allowedPerS = RPM / 60;
  const steadyCompletion = s.throughput.completion_rate_steady_per_s;
  const util = steadyCompletion / allowedPerS;
  const r = s.requests;
  const balanced = r.submitted === r.completed + r.expired + r.rejected_at_api + r.waiting + r.client_errors;
  const checks = [
    { name: `completes >= 90% of allowed capacity after ${warmupS}s warm-up`, ok: util >= 0.9, detail: `${round(steadyCompletion, 1)} completions/s vs ${round(allowedPerS, 1)} allowed/s = ${round(util * 100, 2)}%` },
    { name: 'no 60 s period exceeds 50,000 requests', ok: m.observed_provider.max_trailing_60s_requests <= RPM && m.observed_provider.violations === 0, detail: `max trailing-60s requests at provider = ${fmtInt(m.observed_provider.max_trailing_60s_requests)}` },
    { name: 'no 60 s period exceeds 100M tokens', ok: m.observed_provider.max_trailing_60s_tokens <= TPM, detail: `max trailing-60s tokens at provider = ${fmtInt(m.observed_provider.max_trailing_60s_tokens)}` },
    { name: 'every submitted request accounted for', ok: balanced && r.client_errors === 0, detail: `${fmtInt(r.submitted)} = ${fmtInt(r.completed)} completed + ${fmtInt(r.waiting)} waiting + ${fmtInt(r.expired)} expired + ${fmtInt(r.rejected_at_api)} rejected (+${r.client_errors} errors)` },
  ];
  const passed = checks.every((c) => c.ok);

  const xs = (t) => (t - load.startedAt) / 1000;
  const pa = m.analysis;
  const charts = [
    {
      title: 'Provider-accepted requests per second vs limit',
      svg: lineChart({
        title: 'model-a: requests accepted by provider per second vs RPM limit / 60',
        yLabel: 'req/s',
        series: [
          { name: 'accepted req/s', points: pa.per_second.map((p) => [xs(p[0]), p[1]]) },
          { name: 'completed req/s (gateway)', points: s.completions_per_second.map((p) => [xs(p[0]), p[1]]), color: '#16a34a' },
          { name: 'limit (RPM/60)', points: [[0, RPM / 60], [xs(pa.per_second.at(-1)[0]), RPM / 60]], color: '#dc2626', dash: '6 4' },
        ],
      }),
    },
    {
      title: 'Trailing 60s requests vs limit',
      svg: lineChart({
        title: 'model-a: trailing-60s accepted requests (conservative 60.1 s window) vs RPM limit',
        yLabel: 'requests / 60 s',
        series: [
          { name: 'trailing 60 s requests', points: pa.rolling_60s.map((p) => [xs(p[0]), p[1]]) },
          { name: 'RPM limit', points: pa.rolling_60s.map((p) => [xs(p[0]), p[3]]), color: '#dc2626', dash: '6 4' },
        ],
      }),
    },
    {
      title: 'Queue depth and rejections',
      svg: lineChart({
        title: 'gateway: queue depth and per-second API rejections (backpressure)',
        yLabel: 'requests',
        series: [
          { name: 'queue depth', points: seriesFor(final, 'model-a', 'queue_depth').map(([t, v]) => [xs(t), v]) },
          { name: 'rejected/s', points: seriesFor(final, 'model-a', 'rejected').map(([t, v]) => [xs(t), v]), color: '#ea580c' },
        ],
      }),
    },
  ];

  const md = [
    `# Scenario 1: reach the available provider capacity: ${passed ? 'PASS' : 'FAIL'}`,
    '',
    `Generated ${new Date().toISOString()} by \`node scenarios/scenario1.js${process.argv.slice(2).length ? ` ${process.argv.slice(2).join(' ')}` : ''}\``,
    '',
    `Setup: one model (model-a) at **${fmtInt(RPM)} RPM / ${fmtInt(TPM)} TPM**. Load generator submits 1,000-token requests at **${fmtInt(rate)} req/s** `
      + `(${round((rate * 60 * 100) / RPM, 1)}% of the RPM limit) in batches of ${batchSize} for **${durationS} s**. Gateway: 1 engine shard, `
      + 'pacing at 98% of the limit plus a strict trailing-60 s guard, admission control at 30 s estimated queue wait, request TTL 120 s. '
      + 'Simulated provider: lognormal latency p50 300 ms / p99 2 s, 0.5% transient errors, 0.1% permanent errors.',
    '',
    '## Checks',
    mdTable(['check', 'result', 'measured'], checks.map((c) => [c.name, pass(c.ok), c.detail])),
    '',
    `Drain after submission: ${drain.drained ? `completed in ${round(drain.ms / 1000, 1)} s` : `timed out after ${round(drain.ms / 1000, 1)} s`}.`,
    '',
    '## Results',
    summaryMarkdown(s),
    '',
    '## Environment',
    envMarkdown(s.environment),
  ].join('\n');
  writeReport(outDir, {
    title: 'Scenario 1', markdown: md, charts, json: { passed, checks, summary: { ...s, models: Object.fromEntries(Object.entries(s.models).map(([k, v]) => [k, { ...v, analysis: undefined }])) } },
  });
  console.log(`\n\n${checks.map((c) => `  [${pass(c.ok)}] ${c.name}: ${c.detail}`).join('\n')}`);
  console.log(`\nScenario 1 ${passed ? 'PASSED' : 'FAILED'}; report: ${path.relative(ROOT, outDir)}/report.md`);
  process.exitCode = passed ? 0 : 1;
} finally {
  await stack.stop();
}
