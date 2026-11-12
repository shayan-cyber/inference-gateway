import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep, round, fmtInt } from '../src/common/util.js';
import { analyzeProviderModel, avgRate, gatewayCompletions } from '../src/report/analyze.js';
import { mdTable, environment } from '../src/report/render.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const children = new Set();
function killAll() { for (const c of children) { try { c.kill(); } catch { /* ignore */ } } }
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });

function startProc(name, args, logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(path.join(logDir, `${name}.log`), 'w');
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', fd, fd] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

async function waitHealthy(url, what, child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`${what} exited early (code ${child.exitCode}); see its log`);
    try { return await fetchJson(url, { timeoutMs: 1000 }); } catch { await sleep(100); }
  }
  throw new Error(`${what} did not become healthy at ${url}`);
}

/** Starts provider simulator + gateway as separate OS processes. */
export async function startStack({
  providerConfig, providerShards = 1, gatewayShards = 1, gatewayArgs = [], providerPort = 9000,
  shardBasePort = 9100, gatewayPort = 8000, logDir, seed = 42,
}) {
  const providerUrl = `http://127.0.0.1:${providerPort}`;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const prov = startProc('provider', ['src/provider/server.js', '--config', providerConfig, '--port', String(providerPort),
    '--shards', String(providerShards), '--shard-base-port', String(shardBasePort), '--seed', String(seed)], logDir);
  await waitHealthy(`${providerUrl}/health`, 'provider', prov);
  const gw = startProc('gateway', ['src/gateway/server.js', '--port', String(gatewayPort), '--provider', providerUrl,
    '--shards', String(gatewayShards), '--config', 'config/gateway.default.json', ...gatewayArgs], logDir);
  const health = await waitHealthy(`${gatewayUrl}/healthz`, 'gateway', gw);
  return {
    providerUrl,
    gatewayUrl,
    gatewayPid: health.pid,
    async stop() {
      for (const c of [gw, prov]) { try { c.kill(); } catch { /* ignore */ } }
      await sleep(300);
    },
  };
}

/** Polls gateway stats until nothing is waiting and no callback is pending. */
export async function waitForDrain(gatewayUrl, timeoutMs = 180_000, log = true) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeoutMs) {
    s = await fetchJson(`${gatewayUrl}/v1/stats`);
    if (s.totals.waiting === 0 && s.totals.callbacksPending === 0) return { drained: true, stats: s, ms: Date.now() - t0 };
    if (log) process.stdout.write(`\r  draining: waiting=${fmtInt(s.totals.waiting)} callbacks_pending=${s.totals.callbacksPending}      `);
    await sleep(1000);
  }
  return { drained: false, stats: s, ms: Date.now() - t0 };
}

export function logProgress(prefix, t0) {
  return (st) => {
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\r  ${prefix} t=${el}s submitted=${fmtInt(st.submitted)} accepted=${fmtInt(st.accepted)} rejected=${fmtInt(st.rejected)} open=${st.open ?? ''}      `);
  };
}

export function pass(ok) { return ok ? 'PASS' : 'FAIL'; }

/**
 * Builds the standard run summary required for every run: submitted / completed /
 * succeeded / failed, completion rate, latency percentiles, configured vs observed
 * RPM/TPM per model, batch completion and callback timing.
 */
export function summarizeRun({
  load, atSubmitEnd, finalStats, provider, warmupS = 0,
}) {
  const t0 = load.startedAt;
  const subEnd = load.endedAt;
  const comp = gatewayCompletions(finalStats);
  const steady = avgRate(comp, 1, t0 + warmupS * 1000, subEnd);
  const firstC = comp.find((r) => r[1] > 0);
  const lastC = [...comp].reverse().find((r) => r[1] > 0);
  const overallSecs = firstC && lastC ? (lastC[0] - firstC[0]) / 1000 + 1 : 1;
  const T = finalStats.totals;
  const perModel = {};
  for (const [name, m] of Object.entries(finalStats.models)) {
    const pa = analyzeProviderModel(provider.models[name], provider.limit_history, name);
    const steadyAcc = pa ? avgRate(pa.per_second, 1, t0 + warmupS * 1000, subEnd) : null;
    const steadyTok = pa ? avgRate(pa.per_second, 2, t0 + warmupS * 1000, subEnd) : null;
    perModel[name] = {
      configured: m.limits,
      observed_provider: pa && {
        steady_rpm: round(steadyAcc.perSecond * 60, 0),
        steady_tpm: round(steadyTok.perSecond * 60, 0),
        max_trailing_60s_requests: pa.max_trailing_60s.requests,
        max_trailing_60s_tokens: pa.max_trailing_60s.tokens,
        worst_ratio_to_limit: pa.worst_ratio_to_limit,
        violations: pa.violations,
        totals: pa.totals,
      },
      latency_ms: m.latency_ms,
      analysis: pa,
    };
  }
  return {
    environment: environment(),
    window: {
      started_at: new Date(t0).toISOString(), submission_ended_at: new Date(subEnd).toISOString(), warmup_s: warmupS, steady_seconds: steady.seconds,
    },
    requests: {
      submitted: load.submitted,
      accepted: T.accepted,
      rejected_at_api: load.rejected,
      client_errors: load.errors,
      completed: T.completed,
      succeeded: T.succeeded,
      failed: T.failed,
      expired: T.expired,
      waiting: T.waiting,
      waiting_at_submission_end: atSubmitEnd ? atSubmitEnd.totals.waiting : null,
      retried_attempts: T.retried,
      provider_429s: T.rateLimited,
    },
    throughput: {
      target_submit_rate: load.targetRate,
      achieved_submit_rate: round(load.achievedSubmitRate, 1),
      completion_rate_steady_per_s: round(steady.perSecond, 1),
      completion_rate_overall_per_s: round(T.completed / overallSecs, 1),
    },
    latency_ms: finalStats.latency_ms,
    ack_latency_ms: load.ackLatencyMs,
    batches: finalStats.batches,
    models: perModel,
    completions_per_second: comp,
  };
}

export function summaryMarkdown(s) {
  const r = s.requests;
  const lines = [];
  lines.push('### Requests');
  lines.push(mdTable(['submitted', 'accepted', 'rejected (429 at API)', 'client errors', 'completed', 'succeeded', 'failed', 'expired', 'waiting at end'], [[
    fmtInt(r.submitted), fmtInt(r.accepted), fmtInt(r.rejected_at_api), fmtInt(r.client_errors), fmtInt(r.completed), fmtInt(r.succeeded), fmtInt(r.failed), fmtInt(r.expired), fmtInt(r.waiting),
  ]]));
  lines.push('');
  lines.push(`Accounting: submitted ${fmtInt(r.submitted)} = completed ${fmtInt(r.completed)} + expired ${fmtInt(r.expired)} + rejected ${fmtInt(r.rejected_at_api)} + waiting ${fmtInt(r.waiting)} + client errors ${fmtInt(r.client_errors)}`
    + ` -> ${r.submitted === r.completed + r.expired + r.rejected_at_api + r.waiting + r.client_errors ? 'balanced' : 'NOT balanced'}.`
    + ` Waiting when submission stopped: ${fmtInt(r.waiting_at_submission_end)}. Retry attempts: ${fmtInt(r.retried_attempts)}. Provider 429s: ${fmtInt(r.provider_429s)}.`);
  lines.push('');
  lines.push('### Throughput');
  lines.push(mdTable(['target submit rate (req/s)', 'achieved submit rate', `completion rate after ${s.window.warmup_s}s warm-up (req/s)`, 'completion rate overall (req/s)'], [[
    fmtInt(s.throughput.target_submit_rate), fmtInt(s.throughput.achieved_submit_rate), fmtInt(s.throughput.completion_rate_steady_per_s), fmtInt(s.throughput.completion_rate_overall_per_s),
  ]]));
  lines.push('');
  lines.push('### Latency (ms)');
  const L = (name, h) => [name, fmtInt(h?.count), h?.p50, h?.p95, h?.p99, h?.max];
  lines.push(mdTable(['measure', 'count', 'p50', 'p95', 'p99', 'max'], [
    L('end-to-end (accepted -> final, incl. queueing)', s.latency_ms.end_to_end),
    L('provider round trip (final attempt)', s.latency_ms.provider_round_trip),
    L('API acknowledgement (client side)', s.ack_latency_ms),
  ]));
  lines.push('');
  lines.push('### Limits: configured vs observed (observed = calls the provider simulator accepted)');
  const rows = [];
  for (const [name, m] of Object.entries(s.models)) {
    const o = m.observed_provider;
    rows.push([
      name, fmtInt(m.configured.effective_rpm), fmtInt(o?.steady_rpm), fmtInt(o?.max_trailing_60s_requests),
      fmtInt(m.configured.effective_tpm), fmtInt(o?.steady_tpm), fmtInt(o?.max_trailing_60s_tokens),
      o ? `${round(o.worst_ratio_to_limit.requests * 100, 2)}% / ${round(o.worst_ratio_to_limit.tokens * 100, 2)}%` : '',
      o?.violations, fmtInt(o?.totals.rate_limited),
    ]);
  }
  lines.push(mdTable(['model', 'RPM limit (end)', 'observed RPM (steady)', 'max trailing-60s requests', 'TPM limit (end)', 'observed TPM (steady)', 'max trailing-60s tokens', 'worst trailing-60s / limit (req / tok)', 'windows over limit', 'provider 429s'], rows));
  lines.push('');
  const b = s.batches;
  lines.push('### Batches and callbacks');
  lines.push(mdTable(['batches accepted', 'rejected', 'completed', 'completion p50 / p95 / p99 (ms)', 'callbacks delivered / failed / attempts', 'complete -> delivered p50 / p99 (ms)'], [[
    fmtInt(b.accepted), fmtInt(b.rejected), fmtInt(b.completed),
    `${b.completion_time_ms.p50} / ${b.completion_time_ms.p95} / ${b.completion_time_ms.p99}`,
    `${b.callbacks.delivered} / ${b.callbacks.failed} / ${b.callbacks.attempts}`,
    `${b.callback_delivered_delay_ms.p50} / ${b.callback_delivered_delay_ms.p99}`,
  ]]));
  return lines.join('\n');
}

export function envMarkdown(env, extra = {}) {
  const rows = Object.entries({ ...env, ...extra }).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v]);
  return mdTable(['environment', 'value'], rows);
}

export function reportDir(name) {
  return path.join(ROOT, 'reports', name);
}
