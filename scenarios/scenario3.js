#!/usr/bin/env node
/**
 * Scenario 3: asynchronous batch completion.
 *
 * One batch of 10,000 requests across model-a and model-b, with a callback_url.
 * The simulated provider injects transient errors (8%), timeouts (1%, 2 s) and
 * permanent errors (2%). The callback receiver rejects the first two delivery attempts.
 *
 *   node scenarios/scenario3.js [--size 10000] [--fail-first 2]
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  parseArgs, num, fetchJson, fmtInt, round, sleep,
} from '../shared/util.js';
import { makeRng } from '../shared/rng.js';
import { writeReport, mdTable, lineChart } from '../tools/report/render.js';
import { seriesFor } from '../tools/report/analyze.js';
import {
  startStack, envMarkdown, reportDir, pass, ROOT,
} from './lib.js';
import { environment } from '../tools/report/render.js';
import { startCallbackSink } from './callback-sink.js';

const a = parseArgs();
const size = num(a.size, 10_000);
const failFirst = num(a.failFirst, 2);
const outDir = a.out ? path.resolve(a.out) : reportDir('scenario3');

console.log(`Scenario 3: one batch of ${size} requests over model-a/model-b, callback receiver rejects the first ${failFirst} attempts`);
const stack = await startStack({ providerConfig: 'config/scenario3.provider.json', logDir: path.join(outDir, 'logs') });
const sink = await startCallbackSink({ port: num(a.sinkPort, 9900), failFirst, gatewayUrl: stack.gatewayUrl });
try {
  const rng = makeRng(3);
  const requests = [];
  for (let i = 0; i < size; i++) {
    requests.push({
      request_id: `s3-${String(i).padStart(5, '0')}`,
      model: i % 2 === 0 ? 'model-a' : 'model-b',
      estimated_tokens: 500 + Math.floor(rng.next() * 1000),
      payload: { prompt: `summarise document ${i}` },
    });
  }
  const body = JSON.stringify({ requests, callback_url: sink.url, metadata: { scenario: 3 } });
  const t0 = performance.now();
  const ackRes = await fetch(`${stack.gatewayUrl}/v1/batches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const ack = await ackRes.json();
  const ackMs = performance.now() - t0;
  const submittedAt = Date.now();
  console.log(`  ack in ${round(ackMs, 1)} ms: HTTP ${ackRes.status} ${JSON.stringify(ack)}`);
  const batchId = ack.batch_id;

  // Wait for a successful (2xx) callback.
  const deadline = Date.now() + num(a.timeout, 600_000);
  const progress = [];
  while (Date.now() < deadline && !sink.attempts.some((x) => x.responded === 200)) {
    const st = await fetchJson(`${stack.gatewayUrl}/v1/batches/${batchId}`);
    progress.push({ t: Date.now(), ...st.counts });
    process.stdout.write(`\r  ${st.status}: ok=${st.succeeded} failed=${st.failed} waiting=${st.waiting} callback=${st.callback?.state} attempts=${st.callback?.attempts}     `);
    await sleep(500);
  }
  await sleep(300);
  const status = await fetchJson(`${stack.gatewayUrl}/v1/batches/${batchId}`);
  const results = [];
  for (let off = 0; off !== null;) {
    const page = await fetchJson(`${stack.gatewayUrl}/v1/batches/${batchId}/results?offset=${off}&limit=4000`);
    results.push(...page.results);
    off = page.next_offset;
  }
  const stats = await fetchJson(`${stack.gatewayUrl}/v1/stats?series=1`);
  console.log('');

  const first = sink.attempts[0];
  const delivered = sink.attempts.find((x) => x.responded === 200);
  const cb = delivered?.body;
  const completedAtMs = Date.parse(status.completed_at);
  const fields = ['batch_id', 'status', 'total', 'succeeded', 'failed', 'waiting', 'completed_at', 'created_at', 'duration_ms'];
  const mismatches = [];
  if (cb) {
    for (const f of fields) if (JSON.stringify(cb[f]) !== JSON.stringify(status[f])) mismatches.push(`${f}: callback=${JSON.stringify(cb[f])} api=${JSON.stringify(status[f])}`);
    if (JSON.stringify(cb.counts) !== JSON.stringify(status.counts)) mismatches.push('counts differ');
    if (JSON.stringify(cb.failure_breakdown) !== JSON.stringify(status.failure_breakdown)) mismatches.push('failure_breakdown differs');
  }
  const exactlyOnce = (list) => {
    const want = new Set(requests.map((r) => r.request_id));
    const seen = new Map();
    for (const r of list) seen.set(r.request_id, (seen.get(r.request_id) || 0) + 1);
    const dup = [...seen.values()].filter((c) => c > 1).length;
    const missing = [...want].filter((id) => !seen.has(id)).length;
    const extra = [...seen.keys()].filter((id) => !want.has(id)).length;
    const nonFinal = list.filter((r) => !['succeeded', 'failed', 'expired'].includes(r.status)).length;
    return {
      ok: dup === 0 && missing === 0 && extra === 0 && list.length === want.size && nonFinal === 0, dup, missing, extra, nonFinal, n: list.length,
    };
  };
  const apiOnce = exactlyOnce(results);
  const cbOnce = cb?.results ? exactlyOnce(cb.results) : { ok: false, n: 0 };
  const allAttemptsAfterCompletion = sink.attempts.every((x) => x.receivedAt >= completedAtMs);
  const allFinalAtFirst = first?.statusAtArrival && first.statusAtArrival.waiting === 0 && first.body?.waiting === 0;
  const countsAddUp = cb && cb.succeeded + cb.failed === cb.total;

  const checks = [
    { name: 'acknowledgement returned within 1 s', ok: ackRes.status === 202 && ackMs < 1000, detail: `HTTP ${ackRes.status} in ${round(ackMs, 1)} ms (batch ${batchId}, ${fmtInt(size)} requests, ${fmtInt(body.length)} bytes)` },
    { name: 'callback sent only after all requests are final', ok: !!(allAttemptsAfterCompletion && allFinalAtFirst && countsAddUp), detail: `batch completed ${status.completed_at}; first attempt ${first ? new Date(first.receivedAt).toISOString() : 'none'} (+${first ? first.receivedAt - completedAtMs : '?'} ms); waiting at first attempt = ${first?.statusAtArrival?.waiting}; ${cb ? `${cb.succeeded} + ${cb.failed} = ${cb.total}` : ''}` },
    { name: 'callback delivered after the destination recovers', ok: !!delivered && delivered.n === failFirst + 1 && status.callback?.state === 'delivered', detail: `attempts: ${sink.attempts.map((x) => `#${x.attemptHeader}@+${round((x.receivedAt - completedAtMs) / 1000, 2)}s->${x.responded}`).join(', ')}; gateway callback state = ${status.callback?.state}` },
    { name: 'callback summary matches GET /v1/batches/:id', ok: !!cb && mismatches.length === 0, detail: mismatches.length ? mismatches.join('; ') : `identical on ${fields.join(', ')}, counts, failure_breakdown` },
    { name: 'every request id appears exactly once in the final result', ok: apiOnce.ok && cbOnce.ok, detail: `results API: ${apiOnce.n} rows, ${apiOnce.dup ?? 0} dup, ${apiOnce.missing ?? 0} missing, ${apiOnce.nonFinal ?? 0} non-final; callback inline: ${cbOnce.n} rows, ${cbOnce.dup ?? 0} dup, ${cbOnce.missing ?? 0} missing` },
  ];
  const passed = checks.every((c) => c.ok);

  const byErr = {};
  const attemptsHist = {};
  for (const r of results) {
    const k = `${r.status}${r.error ? ` (${r.error})` : ''}`;
    byErr[k] = (byErr[k] || 0) + 1;
    attemptsHist[r.attempts] = (attemptsHist[r.attempts] || 0) + 1;
  }
  const xs = (t) => (t - submittedAt) / 1000;
  const charts = [{
    title: 'Batch progress',
    svg: lineChart({
      title: `batch ${batchId}: request states over time`,
      yLabel: 'requests',
      markers: [{ x: xs(completedAtMs), label: 'batch complete' }, ...sink.attempts.map((x) => ({ x: xs(x.receivedAt), label: `cb#${x.n} ${x.responded}` }))],
      series: [
        { name: 'succeeded', points: progress.map((p) => [xs(p.t), p.succeeded]), color: '#16a34a' },
        { name: 'failed', points: progress.map((p) => [xs(p.t), p.failed + p.expired]), color: '#dc2626' },
        { name: 'queued', points: progress.map((p) => [xs(p.t), p.queued]) },
        { name: 'in flight + retry wait', points: progress.map((p) => [xs(p.t), p.in_flight + p.retry_wait]), color: '#9333ea' },
      ],
    }),
  }, {
    title: 'Dispatch rate per model',
    svg: lineChart({
      title: 'requests dispatched per second (gateway) per model',
      yLabel: 'req/s',
      series: ['model-a', 'model-b'].map((mname, i) => ({ name: mname, points: seriesFor(stats, mname, 'dispatched').map(([t, v]) => [xs(t), v]), color: i ? '#ea580c' : '#2563eb' })),
    }),
  }];
  const md = [
    `# Scenario 3: asynchronous batch completion: ${passed ? 'PASS' : 'FAIL'}`,
    '',
    `Generated ${new Date().toISOString()} by \`node scenarios/scenario3.js${process.argv.slice(2).length ? ` ${process.argv.slice(2).join(' ')}` : ''}\``,
    '',
    `Setup: one batch of ${fmtInt(size)} requests (half model-a at 30,000 RPM, half model-b at 20,000 RPM, 500-1,500 tokens each) with a callback_url. `
      + 'The simulated provider returns 8% transient errors, 1% timeouts (after 2 s) and 2% permanent errors per call. Transient errors and timeouts are retried '
      + '(up to 4 attempts, exponential backoff); permanent errors fail at once. '
      + `The callback receiver answers 503 to the first ${failFirst} delivery attempts, then 200. Callback retry backoff: 1 s, 2 s, 4 s, ... (+/-20% jitter).`,
    '',
    '## Checks',
    mdTable(['check', 'result', 'measured'], checks.map((c) => [c.name, pass(c.ok), c.detail])),
    '',
    '## Batch outcome',
    mdTable(['status', 'total', 'succeeded', 'failed (provider/retries)', 'expired', 'batch duration (ms)', 'complete -> delivered (ms)'], [[
      status.status, fmtInt(status.total), fmtInt(status.succeeded), fmtInt(status.failure_breakdown.provider_or_retries), fmtInt(status.failure_breakdown.expired), fmtInt(status.duration_ms),
      delivered ? fmtInt(delivered.receivedAt - completedAtMs) : 'n/a',
    ]]),
    '',
    'Final state per request:',
    mdTable(['final state', 'requests'], Object.entries(byErr).sort().map(([k, v]) => [k, fmtInt(v)])),
    '',
    'Provider attempts per request:',
    mdTable(['attempts', 'requests'], Object.entries(attemptsHist).map(([k, v]) => [k, fmtInt(v)])),
    '',
    '## Callback delivery attempts (as seen by the receiver)',
    mdTable(['#', 'X-Callback-Attempt', 'Idempotency-Key', 'received (+ms after completion)', 'receiver answered', 'batch waiting at arrival'], sink.attempts.map((x) => [
      x.n, x.attemptHeader, x.idempotencyKey, `${new Date(x.receivedAt).toISOString()} (+${x.receivedAt - completedAtMs})`, x.responded, x.statusAtArrival?.waiting,
    ])),
    '',
    'Delivered callback body (results truncated):',
    '```json',
    JSON.stringify({ ...cb, results: cb?.results ? [...cb.results.slice(0, 3), `... ${cb.results.length - 3} more`] : null }, null, 2),
    '```',
    '',
    '## Environment',
    envMarkdown(environment()),
  ].join('\n');
  writeReport(outDir, {
    title: 'Scenario 3',
    markdown: md,
    charts,
    json: {
      passed, checks, ack_ms: ackMs, ack, status, callback_attempts: sink.attempts.map((x) => ({ ...x, body: x.body ? { ...x.body, results: `[${x.body.results?.length} results]` } : null })), final_states: byErr, attempts: attemptsHist,
    },
  });
  console.log(`\n${checks.map((c) => `  [${pass(c.ok)}] ${c.name}: ${c.detail}`).join('\n')}`);
  console.log(`\nScenario 3 ${passed ? 'PASSED' : 'FAILED'}; report: ${path.relative(ROOT, outDir)}/report.md`);
  process.exitCode = passed ? 0 : 1;
} finally {
  await sink.close();
  await stack.stop();
}
