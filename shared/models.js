/**
 * Model configuration as used by the provider simulator. External JSON uses
 * snake_case; internally we use camelCase.
 *
 * {
 *   "name": "model-a",
 *   "rpm": 50000, "tpm": 100000000,
 *   "latency":  { "distribution": "lognormal", "median_ms": 300, "p99_ms": 2000,
 *                 "min_ms": 20, "max_ms": 30000, "per_1k_tokens_ms": 0 },
 *   "outcomes": { "transient_error_rate": 0.005, "permanent_error_rate": 0.001,
 *                 "timeout_rate": 0, "timeout_ms": 5000 },
 *   "output_tokens_ratio": 0.25
 * }
 *
 * latency.distribution: "lognormal" (median_ms, p99_ms), "fixed" (median_ms),
 * or "uniform" (min_ms..max_ms).
 */
export const DEFAULT_MODEL = {
  rpm: 50_000,
  tpm: 100_000_000,
  latency: { distribution: 'lognormal', medianMs: 300, p99Ms: 2000, minMs: 20, maxMs: 30_000, per1kTokensMs: 0 },
  outcomes: { transientErrorRate: 0.005, permanentErrorRate: 0.001, timeoutRate: 0, timeoutMs: 5000 },
  outputTokensRatio: 0.25,
};

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);

export function normalizeModel(raw, base = null) {
  if (!raw || typeof raw !== 'object') throw new Error('model config must be an object');
  const b = base || { ...DEFAULT_MODEL, name: raw.name };
  const lat = raw.latency || {};
  const out = raw.outcomes || {};
  const m = {
    name: pick(raw.name, b.name),
    rpm: Number(pick(raw.rpm, b.rpm)),
    tpm: Number(pick(raw.tpm, b.tpm)),
    latency: {
      distribution: pick(lat.distribution, b.latency.distribution),
      medianMs: Number(pick(lat.median_ms, lat.medianMs, b.latency.medianMs)),
      p99Ms: Number(pick(lat.p99_ms, lat.p99Ms, b.latency.p99Ms)),
      minMs: Number(pick(lat.min_ms, lat.minMs, b.latency.minMs)),
      maxMs: Number(pick(lat.max_ms, lat.maxMs, b.latency.maxMs)),
      per1kTokensMs: Number(pick(lat.per_1k_tokens_ms, lat.per1kTokensMs, b.latency.per1kTokensMs)),
    },
    outcomes: {
      transientErrorRate: Number(pick(out.transient_error_rate, out.transientErrorRate, b.outcomes.transientErrorRate)),
      permanentErrorRate: Number(pick(out.permanent_error_rate, out.permanentErrorRate, b.outcomes.permanentErrorRate)),
      timeoutRate: Number(pick(out.timeout_rate, out.timeoutRate, b.outcomes.timeoutRate)),
      timeoutMs: Number(pick(out.timeout_ms, out.timeoutMs, b.outcomes.timeoutMs)),
    },
    outputTokensRatio: Number(pick(raw.output_tokens_ratio, raw.outputTokensRatio, b.outputTokensRatio)),
  };
  validateModel(m);
  return m;
}

export function validateModel(m) {
  if (typeof m.name !== 'string' || !/^[\w.\-:/]{1,100}$/.test(m.name)) throw new Error(`invalid model name: ${m.name}`);
  for (const k of ['rpm', 'tpm']) {
    if (!Number.isFinite(m[k]) || m[k] < 0) throw new Error(`${m.name}: ${k} must be a non-negative number`);
  }
  if (!['lognormal', 'fixed', 'uniform'].includes(m.latency.distribution)) {
    throw new Error(`${m.name}: latency.distribution must be lognormal | fixed | uniform`);
  }
  if (m.latency.maxMs > 60_000) throw new Error(`${m.name}: latency.max_ms must be <= 60000`);
  const o = m.outcomes;
  const total = o.transientErrorRate + o.permanentErrorRate + o.timeoutRate;
  if ([o.transientErrorRate, o.permanentErrorRate, o.timeoutRate].some((x) => !(x >= 0 && x <= 1)) || total > 1) {
    throw new Error(`${m.name}: outcome rates must be within [0,1] and sum to <= 1`);
  }
  if (o.timeoutMs > 60_000) throw new Error(`${m.name}: outcomes.timeout_ms must be <= 60000`);
}

export function modelToJson(m) {
  return {
    name: m.name,
    rpm: m.rpm,
    tpm: m.tpm,
    latency: {
      distribution: m.latency.distribution,
      median_ms: m.latency.medianMs,
      p99_ms: m.latency.p99Ms,
      min_ms: m.latency.minMs,
      max_ms: m.latency.maxMs,
      per_1k_tokens_ms: m.latency.per1kTokensMs,
    },
    outcomes: {
      transient_error_rate: m.outcomes.transientErrorRate,
      permanent_error_rate: m.outcomes.permanentErrorRate,
      timeout_rate: m.outcomes.timeoutRate,
      timeout_ms: m.outcomes.timeoutMs,
    },
    output_tokens_ratio: m.outputTokensRatio,
  };
}
