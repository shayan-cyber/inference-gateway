#!/usr/bin/env node
/**
 * Load generator CLI.
 *
 *   node src/loadgen/cli.js --rate 2000 --duration 60 --models model-a:0.7,model-b:0.3 \
 *        --batch-size 100 --tokens 1000 [--token-jitter 0.2] [--payload-bytes 64] \
 *        [--mode batch|single] [--concurrency 64] [--workers 1] [--callback-url URL] \
 *        [--gateway http://127.0.0.1:8000] [--provider http://127.0.0.1:9000] \
 *        [--drain true] [--drain-timeout 180] [--warmup 0] [--out reports/my-run]
 *
 * After submission it waits for the gateway to drain (all requests final, callbacks
 * done), then prints the run report: submitted / completed / succeeded / failed,
 * completion rate, p50/p95/p99 latency, configured vs observed RPM and TPM per model
 * (observed from the provider simulator's metrics when --provider is reachable),
 * batch completion and callback timing.
 */
import path from 'node:path';
import {
  parseArgs, num, bool, fetchJson, fmtInt,
} from '../common/util.js';
import { runLoad, parseModelMix } from './loadgen.js';
import { writeReport } from '../report/render.js';
import {
  waitForDrain, summarizeRun, summaryMarkdown, envMarkdown, logProgress,
} from '../../scenarios/lib.js';

const a = parseArgs();
const gateway = (a.gateway || 'http://127.0.0.1:8000').replace(/\/$/, '');
const providerUrl = (a.provider || 'http://127.0.0.1:9000').replace(/\/$/, '');
const opts = {
  gateway,
  rate: num(a.rate, 1000),
  durationS: num(a.duration, 30),
  models: parseModelMix(a.models),
  batchSize: num(a.batchSize, 100),
  tokens: num(a.tokens, 1000),
  tokenJitter: num(a.tokenJitter, 0),
  payloadBytes: num(a.payloadBytes, 64),
  concurrency: num(a.concurrency, 64),
  workers: num(a.workers, 1),
  mode: a.mode || 'batch',
  callbackUrl: a.callbackUrl || null,
  ttlMs: a.ttlMs ? num(a.ttlMs) : null,
  includeIds: bool(a.ids, true),
};

console.log(`loadgen: ${fmtInt(opts.rate)} req/s for ${opts.durationS}s -> ${gateway} (${opts.mode}, batch ${opts.batchSize}, ${opts.tokens} tokens, mix ${opts.models.map((m) => `${m.name}:${m.weight}`).join(',')})`);
const t0 = Date.now();
const load = await runLoad(opts, { onSecond: logProgress('load', t0) });
const atEnd = await fetchJson(`${gateway}/v1/stats`);
console.log(`\nsubmission done: submitted=${fmtInt(load.submitted)} accepted=${fmtInt(load.accepted)} rejected=${fmtInt(load.rejected)} waiting=${fmtInt(atEnd.totals.waiting)}`);
if (bool(a.drain, true)) {
  const d = await waitForDrain(gateway, num(a.drainTimeout, 180) * 1000);
  console.log(`\n${d.drained ? 'drained' : 'drain timed out'} after ${(d.ms / 1000).toFixed(1)} s`);
}
const final = await fetchJson(`${gateway}/v1/stats?series=1&since_ms=${load.startedAt - 1000}`);
let provider = null;
try { provider = await fetchJson(`${providerUrl}/v1/metrics?since_ms=${load.startedAt - 1000}`); } catch { /* provider metrics optional */ }
if (!provider) provider = { models: {}, limit_history: [] };
const s = summarizeRun({
  load, atSubmitEnd: atEnd, finalStats: final, provider, warmupS: num(a.warmup, 0),
});
const md = `# Load run\n\n\`node src/loadgen/cli.js ${process.argv.slice(2).join(' ')}\`\n\n${summaryMarkdown(s)}\n\n## Environment\n${envMarkdown(s.environment)}`;
console.log(`\n${md}`);
if (a.out) {
  writeReport(path.resolve(a.out), {
    title: 'Load run', markdown: md, json: { ...s, models: Object.fromEntries(Object.entries(s.models).map(([k, v]) => [k, { ...v, analysis: undefined }])) },
  });
  console.log(`\nreport written to ${a.out}`);
}
