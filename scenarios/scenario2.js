#!/usr/bin/env node
/**
 * Scenario 2: different models and changing limits.
 *
 * model-a = 30,000 RPM / 60M TPM, model-b = 20,000 RPM / 40M TPM. Both get traffic above
 * their limits. Part way through, the PROVIDER lowers model-a to 5,000 RPM, later
 * restores 30,000 RPM. model-b is untouched. The gateway is never restarted; it learns
 * the new limits from the provider (polling plus an immediate re-read on any 429).
 *
 *   node scenarios/scenario2.js [--phase 120] [--rate 1100] [--mix model-a:0.6,model-b:0.4]
 *
 * Timeline (phase = P seconds): 0..P normal, P..2P model-a reduced, 2P..3P restored.
 */
import path from 'node:path';
import {
  parseArgs, num, fetchJson, fmtInt, round, sleep,
} from '../shared/util.js';
import { runLoad, parseModelMix } from '../tools/loadgen/loadgen.js';
import { lineChart, writeReport, mdTable } from '../tools/report/render.js';
import { avgRate, seriesFor } from '../tools/report/analyze.js';
import {
  startStack, waitForDrain, summarizeRun, summaryMarkdown, envMarkdown, reportDir, logProgress, pass, ROOT,
} from './lib.js';

const a = parseArgs();
const P = num(a.phase, 120);
const rate = num(a.rate, 1100);
const mix = parseModelMix(a.mix || 'model-a:0.6,model-b:0.4');
const batchSize = num(a.batchSize, 100);
const A_RPM = 30_000; const A_TPM = 60_000_000; const A_LOW = 5_000;
const B_RPM = 20_000; const B_TPM = 40_000_000;
const outDir = a.out ? path.resolve(a.out) : reportDir('scenario2');

console.log(`Scenario 2: ${rate} req/s mix ${JSON.stringify(mix)} for ${3 * P}s; model-a -> ${A_LOW} RPM at ${P}s, restored at ${2 * P}s`);
const stack = await startStack({ providerConfig: 'config/scenario2.provider.json', logDir: path.join(outDir, 'logs') });
try {
  const t0 = Date.now();
  const events = [];
  const pidBefore = (await fetchJson(`${stack.gatewayUrl}/healthz`)).pid;
  const changer = (async () => {
    await sleep(P * 1000 - (Date.now() - t0));
    await fetchJson(`${stack.providerUrl}/v1/models/model-a`, { method: 'PATCH', body: { rpm: A_LOW } });
    events.push({ t: Date.now(), what: `model-a -> ${A_LOW} RPM` });
    console.log(`\n  >>> provider lowered model-a to ${A_LOW} RPM`);
    await sleep(2 * P * 1000 - (Date.now() - t0));
    await fetchJson(`${stack.providerUrl}/v1/models/model-a`, { method: 'PATCH', body: { rpm: A_RPM } });
    events.push({ t: Date.now(), what: `model-a -> ${A_RPM} RPM` });
    console.log(`\n  >>> provider restored model-a to ${A_RPM} RPM`);
  })();
  const load = await runLoad({
    gateway: stack.gatewayUrl, rate, durationS: 3 * P, batchSize, tokens: 1000, models: mix, concurrency: 64,
  }, { onSecond: logProgress('load', t0) });
  await changer;
  const atEnd = await fetchJson(`${stack.gatewayUrl}/v1/stats`);
  console.log(`\n  submission finished; waiting=${fmtInt(atEnd.totals.waiting)}; draining...`);
  const drain = await waitForDrain(stack.gatewayUrl, num(a.drainTimeout, 180_000));
  const final = await fetchJson(`${stack.gatewayUrl}/v1/stats?series=1`);
  const prov = await fetchJson(`${stack.providerUrl}/v1/metrics`);
  const gwLimits = await fetchJson(`${stack.gatewayUrl}/v1/limit-history`);
  const pidAfter = (await fetchJson(`${stack.gatewayUrl}/healthz`)).pid;
  const s = summarizeRun({
    load, atSubmitEnd: atEnd, finalStats: final, provider: prov, warmupS: 0,
  });

  const ls = load.startedAt;
  const tReduce = events[0].t; const tRestore = events[1].t; const tEnd = load.endedAt;
  const A = s.models['model-a'].analysis; const B = s.models['model-b'].analysis;
  const rate60 = (pa, col, from, to) => avgRate(pa.per_second, col, from, to).perSecond * 60;
  // Phases. After a reduction the strict window has to drain (up to 60 s) before
  // model-a may run again, so the constrained steady state is measured from +60 s.
  const aBefore = rate60(A, 1, ls + 30_000, tReduce);
  const aConstrained = rate60(A, 1, tReduce + 62_000, tRestore);
  const aAfter = rate60(A, 1, tRestore + 30_000, tEnd);
  const bBefore = rate60(B, 1, ls + 30_000, tReduce);
  const bDuring = rate60(B, 1, tReduce, tRestore);
  const bAfter = rate60(B, 1, tRestore, tEnd);
  // When did model-a's provider limit change take effect at the gateway?
  const gwA = gwLimits.limit_history.filter((h) => h.model === 'model-a');
  const seen = (rpm, after) => gwA.find((h) => h.rpm === rpm && h.t >= after - 5);
  const reduceSeen = seen(A_LOW, tReduce); const restoreSeen = seen(A_RPM, tRestore);
  const constrainedPhaseTooShort = tRestore - tReduce <= 62_000;

  const checks = [
    { name: 'model-a within its current limit at all times', ok: A.violations === 0, detail: `worst trailing-60s / limit-in-force = ${round(A.worst_ratio_to_limit.requests * 100, 2)}% (req), ${round(A.worst_ratio_to_limit.tokens * 100, 2)}% (tok); ${A.violations} buckets over` },
    { name: 'model-b within its current limit at all times', ok: B.violations === 0, detail: `worst trailing-60s / limit = ${round(B.worst_ratio_to_limit.requests * 100, 2)}% (req), ${round(B.worst_ratio_to_limit.tokens * 100, 2)}% (tok); ${B.violations} buckets over` },
    { name: 'model-a adjusts to the reduction without restart', ok: !!reduceSeen && (constrainedPhaseTooShort || (aConstrained <= A_LOW && aConstrained >= 0.85 * A_LOW)), detail: `gateway applied ${A_LOW} RPM ${reduceSeen ? `${reduceSeen.t - tReduce} ms` : 'never'} after the provider change; steady rate once the 60 s window drained = ${fmtInt(aConstrained)} RPM (limit ${fmtInt(A_LOW)})` },
    { name: 'model-a adjusts to the restore without restart', ok: !!restoreSeen && aAfter >= 0.85 * A_RPM && pidBefore === pidAfter, detail: `gateway applied ${A_RPM} RPM ${restoreSeen ? `${restoreSeen.t - tRestore} ms` : 'never'} after the change; rate after restore = ${fmtInt(aAfter)} RPM; gateway pid ${pidBefore} -> ${pidAfter}` },
    { name: 'model-b keeps processing while model-a is constrained', ok: bDuring >= 0.9 * B_RPM, detail: `model-b ${fmtInt(bBefore)} RPM before, ${fmtInt(bDuring)} RPM during, ${fmtInt(bAfter)} RPM after (limit ${fmtInt(B_RPM)})` },
  ];
  const passed = checks.every((c) => c.ok);

  const xs = (t) => (t - ls) / 1000;
  const markers = [{ x: xs(tReduce), label: `A -> ${A_LOW / 1000}k RPM` }, { x: xs(tRestore), label: `A -> ${A_RPM / 1000}k RPM` }];
  const step = (pa) => pa.rolling_60s.map((p) => [xs(p[0]), p[3] / 60]);
  const charts = [
    {
      title: 'Per-second throughput vs limits',
      svg: lineChart({
        title: 'requests accepted by provider per second, with each model\'s RPM limit / 60',
        yLabel: 'req/s',
        markers,
        series: [
          { name: 'model-a accepted/s', points: A.per_second.map((p) => [xs(p[0]), p[1]]) },
          { name: 'model-a limit/60', points: step(A), color: '#2563eb', dash: '6 4', step: true },
          { name: 'model-b accepted/s', points: B.per_second.map((p) => [xs(p[0]), p[1]]), color: '#ea580c' },
          { name: 'model-b limit/60', points: step(B), color: '#ea580c', dash: '6 4', step: true },
        ],
      }),
    },
    {
      title: 'Trailing 60s usage vs limit',
      svg: lineChart({
        title: 'trailing-60s accepted requests vs the RPM limit in force',
        yLabel: 'requests / 60 s',
        markers,
        series: [
          { name: 'model-a trailing 60 s', points: A.rolling_60s.map((p) => [xs(p[0]), p[1]]) },
          { name: 'model-a limit', points: A.rolling_60s.map((p) => [xs(p[0]), p[3]]), color: '#2563eb', dash: '6 4', step: true },
          { name: 'model-b trailing 60 s', points: B.rolling_60s.map((p) => [xs(p[0]), p[1]]), color: '#ea580c' },
          { name: 'model-b limit', points: B.rolling_60s.map((p) => [xs(p[0]), p[3]]), color: '#ea580c', dash: '6 4', step: true },
        ],
      }),
    },
    {
      title: 'Gateway queue depth',
      svg: lineChart({
        title: 'gateway queue depth per model',
        yLabel: 'queued requests',
        markers,
        series: [
          { name: 'model-a', points: seriesFor(final, 'model-a', 'queue_depth').map(([t, v]) => [xs(t), v]) },
          { name: 'model-b', points: seriesFor(final, 'model-b', 'queue_depth').map(([t, v]) => [xs(t), v]), color: '#ea580c' },
        ],
      }),
    },
  ];
  const timeline = [];
  for (let t = Math.floor(ls / 10_000) * 10_000; t < tEnd; t += 10_000) {
    const la = A.rolling_60s.find((p) => p[0] >= t) || [];
    const lb = B.rolling_60s.find((p) => p[0] >= t) || [];
    timeline.push([
      Math.round(xs(t)), fmtInt(la[3]), fmtInt(rate60(A, 1, t, t + 10_000)), fmtInt(la[1]), fmtInt(lb[3]), fmtInt(rate60(B, 1, t, t + 10_000)), fmtInt(lb[1]),
    ]);
  }
  const md = [
    `# Scenario 2: different models and changing limits: ${passed ? 'PASS' : 'FAIL'}`,
    '',
    `Generated ${new Date().toISOString()} by \`node scenarios/scenario2.js${process.argv.slice(2).length ? ` ${process.argv.slice(2).join(' ')}` : ''}\``,
    '',
    `Setup: model-a ${fmtInt(A_RPM)} RPM / ${fmtInt(A_TPM)} TPM, model-b ${fmtInt(B_RPM)} RPM / ${fmtInt(B_TPM)} TPM. Load: ${fmtInt(rate)} req/s of 1,000-token requests, mix ${mix.map((m) => `${m.name} ${m.weight}`).join(', ')} `
      + `(both models above their limits). At t=${P}s the provider lowers model-a to ${fmtInt(A_LOW)} RPM; at t=${2 * P}s it restores ${fmtInt(A_RPM)} RPM. `
      + 'The gateway is not restarted: it polls the provider\'s limits every second and re-reads them immediately when it sees a 429.',
    '',
    'Limit semantics: a request is admitted only if the trailing 60 s (including it) stays within the limit **in force at that moment**. '
      + `So after model-a drops to ${fmtInt(A_LOW)} RPM, it pauses until its trailing-minute usage (~${fmtInt(A_RPM)}) ages below ${fmtInt(A_LOW)}, then runs at ~${fmtInt(A_LOW)} RPM. `
      + 'Restoring the limit takes effect immediately.',
    '',
    '## Checks',
    mdTable(['check', 'result', 'measured'], checks.map((c) => [c.name, pass(c.ok), c.detail])),
    '',
    '## Configured limit and observed throughput over time (10 s steps, provider-side)',
    mdTable(['t (s)', 'A limit RPM', 'A observed RPM (10 s avg x 60)', 'A trailing 60 s', 'B limit RPM', 'B observed RPM', 'B trailing 60 s'], timeline),
    '',
    `Limit changes seen by the gateway: ${gwA.map((h) => `${new Date(h.t).toISOString().slice(11, 23)} ${h.model} ${fmtInt(h.rpm)} RPM (${h.source})`).join('; ')}`,
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
    title: 'Scenario 2',
    markdown: md,
    charts,
    json: {
      passed, checks, events, gateway_limit_history: gwLimits.limit_history, summary: { ...s, models: Object.fromEntries(Object.entries(s.models).map(([k, v]) => [k, { ...v, analysis: undefined }])) },
    },
  });
  console.log(`\n\n${checks.map((c) => `  [${pass(c.ok)}] ${c.name}: ${c.detail}`).join('\n')}`);
  console.log(`\nScenario 2 ${passed ? 'PASSED' : 'FAILED'}; report: ${path.relative(ROOT, outDir)}/report.md`);
  process.exitCode = passed ? 0 : 1;
} finally {
  await stack.stop();
}
