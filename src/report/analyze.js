/**
 * Turns raw metrics into the numbers the scenarios are judged on.
 *
 * Ground truth for "did we exceed the limit" is the PROVIDER simulator's own record of
 * calls it accepted (100 ms buckets on its clock), not the gateway's view.
 */
const WINDOW_BUCKETS = 601; // 60.1 s of 100 ms buckets: an upper bound for ANY 60 s period

/** Limit entries for `model`, sorted by time. */
function entriesFor(history, model) {
  return history.filter((h) => h.model === model).sort((a, b) => a.t - b.t);
}

export function limitAt(history, model, t) {
  let cur = null;
  for (const h of entriesFor(history, model)) if (h.t <= t) cur = h;
  return cur;
}

/** The most permissive limit in force at any moment in [t0, t1] (used for one bucket). */
function maxLimitDuring(entries, t0, t1) {
  let rpm = -1; let tpm = -1; let cur = null;
  for (const h of entries) {
    if (h.t <= t0) cur = h;
    else if (h.t <= t1) { rpm = Math.max(rpm, h.rpm); tpm = Math.max(tpm, h.tpm); }
  }
  if (cur) { rpm = Math.max(rpm, cur.rpm); tpm = Math.max(tpm, cur.tpm); }
  return { rpm, tpm };
}

/**
 * rows: provider 100 ms rows [t, accepted, accepted_tokens, rate_limited, ok, transient, permanent, timeout]
 * Checks, for every bucket in which the provider accepted calls, that the trailing
 * 60.1 s of accepted requests/tokens is within the limit in force at that time.
 */
export function analyzeProviderModel(rows, history, model, bucketMs = 100) {
  if (!rows || rows.length === 0) return null;
  const entries = entriesFor(history, model);
  const t0 = rows[0][0];
  const t1 = rows[rows.length - 1][0];
  const N = Math.round((t1 - t0) / bucketMs) + 1;
  const acc = new Float64Array(N);
  const tok = new Float64Array(N);
  const r429 = new Float64Array(N);
  const totals = {
    accepted: 0, accepted_tokens: 0, rate_limited: 0, ok: 0, transient: 0, permanent: 0, timeout: 0,
  };
  for (const r of rows) {
    const k = Math.round((r[0] - t0) / bucketMs);
    acc[k] = r[1]; tok[k] = r[2]; r429[k] = r[3];
    totals.accepted += r[1]; totals.accepted_tokens += r[2]; totals.rate_limited += r[3];
    totals.ok += r[4]; totals.transient += r[5]; totals.permanent += r[6]; totals.timeout += r[7];
  }
  let rsReq = 0; let rsTok = 0;
  let worstReq = 0; let worstTok = 0; let violations = 0;
  let worstReqAt = null; let worstTokAt = null;
  let maxReq = 0; let maxTok = 0;
  const rolling = []; // per second: [t, rollingReq, rollingTok, limitRpm, limitTpm]
  const perSecond = new Map();
  for (let k = 0; k < N; k++) {
    rsReq += acc[k]; rsTok += tok[k];
    if (k >= WINDOW_BUCKETS) { rsReq -= acc[k - WINDOW_BUCKETS]; rsTok -= tok[k - WINDOW_BUCKETS]; }
    const t = t0 + k * bucketMs;
    if (rsReq > maxReq) maxReq = rsReq;
    if (rsTok > maxTok) maxTok = rsTok;
    if (acc[k] > 0) {
      const lim = maxLimitDuring(entries, t, t + bucketMs - 1);
      const rr = lim.rpm > 0 ? rsReq / lim.rpm : Infinity;
      const rt = lim.tpm > 0 ? rsTok / lim.tpm : Infinity;
      if (rr > worstReq) { worstReq = rr; worstReqAt = t; }
      if (rt > worstTok) { worstTok = rt; worstTokAt = t; }
      if (rsReq > lim.rpm + 1e-9 || rsTok > lim.tpm + 1e-9) violations++;
    }
    const sec = Math.floor(t / 1000) * 1000;
    let ps = perSecond.get(sec);
    if (!ps) { ps = [sec, 0, 0, 0]; perSecond.set(sec, ps); }
    ps[1] += acc[k]; ps[2] += tok[k]; ps[3] += r429[k];
    if (t % 1000 === 900) {
      const l = limitAt(history, model, t) || { rpm: null, tpm: null };
      rolling.push([sec, rsReq, rsTok, l.rpm, l.tpm]);
    }
  }
  return {
    model,
    totals,
    max_trailing_60s: { requests: maxReq, tokens: maxTok },
    worst_ratio_to_limit: { requests: worstReq, requests_at: worstReqAt, tokens: worstTok, tokens_at: worstTokAt },
    violations,
    per_second: [...perSecond.values()],
    rolling_60s: rolling,
  };
}

/** Average per-second value of column `col` over [fromMs, toMs). */
export function avgRate(perSecond, col, fromMs, toMs) {
  let s = 0; let n = 0;
  for (const r of perSecond) {
    if (r[0] >= fromMs && r[0] < toMs) { s += r[col]; n++; }
  }
  const secs = Math.max(1, Math.round((toMs - fromMs) / 1000));
  return { total: s, seconds: secs, perSecond: s / secs, buckets: n };
}

/** Sum of gateway per-second series across models: completed = succeeded + failed. */
export function gatewayCompletions(stats) {
  const fields = stats.series_fields;
  const idx = Object.fromEntries(fields.map((f, i) => [f, i]));
  const bySec = new Map();
  for (const m of Object.values(stats.models)) {
    for (const r of m.series || []) {
      let a = bySec.get(r[0]);
      if (!a) { a = [r[0], 0, 0, 0, 0, 0, 0]; bySec.set(r[0], a); }
      a[1] += r[idx.succeeded] + r[idx.failed];
      a[2] += r[idx.succeeded];
      a[3] += r[idx.failed];
      a[4] += r[idx.expired];
      a[5] += r[idx.dispatched];
      a[6] += r[idx.queue_depth];
    }
  }
  return [...bySec.values()].sort((a, b) => a[0] - b[0]);
}

export function seriesFor(stats, model, field) {
  const idx = stats.series_fields.indexOf(field);
  return (stats.models[model]?.series || []).map((r) => [r[0], r[idx]]);
}
