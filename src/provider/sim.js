import { ModelLimiter } from '../common/limiter.js';
import { makeRng } from '../common/rng.js';
import { BucketSeries } from '../common/series.js';
import {
  S_OK, S_RATE_LIMITED, S_TRANSIENT, S_PERMANENT, S_TIMEOUT,
} from '../common/proto.js';

/** Fields recorded per model in 100 ms buckets, keyed by the provider's wall clock. */
export const PROVIDER_FIELDS = [
  'accepted', 'accepted_tokens', 'rate_limited', 'ok', 'transient', 'permanent', 'timeout',
];
const F_ACC = 0; const F_ACC_TOK = 1; const F_429 = 2; const F_OK = 3; const F_TR = 4; const F_PERM = 5; const F_TO = 6;
export const PROVIDER_BUCKET_MS = 100;

const WHEEL_BITS = 16; // 65,536 ms of scheduling horizon (latency is capped at 60 s)
const WHEEL = 1 << WHEEL_BITS;
const MASK = WHEEL - 1;

/**
 * Simulated inference provider (one shard).
 *
 * Every call is individually: checked against the model's RPM/TPM (strict trailing
 * 60 s window: over-limit calls get 429), given a sampled outcome, given a sampled
 * latency, and answered when that latency elapses. Completions are scheduled on a
 * 1 ms timing wheel and flushed to each connection ("sink") in batches.
 *
 * With N shards each shard enforces limit/N; the gateway is sharded the same way.
 */
export class ProviderSim {
  constructor({ models = [], shardIndex = 0, shardCount = 1, seed = 42, onResults, metricsKeepBuckets = 36_000 }) {
    this.shardIndex = shardIndex;
    this.shardCount = shardCount;
    this.rng = makeRng(seed * 7919 + shardIndex * 104729 + 1);
    this.onResults = onResults; // (sinkId, flat, n)
    this.models = new Map();
    this.metricsKeep = metricsKeepBuckets;
    this.wheel = new Array(WHEEL);
    for (let i = 0; i < WHEEL; i++) this.wheel[i] = [];
    this.wheelCount = 0;
    this.lastMs = -1;
    this.out = new Map(); // sinkId -> { flat: number[], n }
    this.totals = { calls: 0, accepted: 0, rateLimited: 0, unknownModel: 0, payloadBytes: 0 };
    for (const m of models) this.upsertModel(m);
  }

  upsertModel(cfg) {
    const share = 1 / this.shardCount;
    let st = this.models.get(cfg.name);
    if (!st) {
      st = {
        cfg,
        limiter: new ModelLimiter({ rpm: cfg.rpm * share, tpm: cfg.tpm * share, pacing: false }),
        series: new BucketSeries(PROVIDER_FIELDS, PROVIDER_BUCKET_MS, this.metricsKeep),
      };
      this.models.set(cfg.name, st);
    } else {
      st.cfg = cfg;
      st.limiter.setLimits(cfg.rpm * share, cfg.tpm * share);
    }
    const l = cfg.latency;
    st.mu = Math.log(Math.max(0.001, l.medianMs));
    st.sigma = l.p99Ms > l.medianMs ? Math.log(l.p99Ms / l.medianMs) / 2.3263 : 0;
    const o = cfg.outcomes;
    st.pPerm = o.permanentErrorRate;
    st.pTrans = st.pPerm + o.transientErrorRate;
    st.pTimeout = st.pTrans + o.timeoutRate;
  }

  _sampleLatency(st, tokens) {
    const l = st.cfg.latency;
    let ms;
    if (l.distribution === 'fixed') ms = l.medianMs;
    else if (l.distribution === 'uniform') ms = l.minMs + this.rng.next() * (l.maxMs - l.minMs);
    else ms = Math.exp(st.mu + st.sigma * this.rng.normal());
    if (l.per1kTokensMs) ms += (tokens / 1000) * l.per1kTokensMs;
    if (ms < l.minMs) ms = l.minMs;
    if (ms > l.maxMs) ms = l.maxMs;
    return ms;
  }

  _emit(sinkId, callId, status, latUs, outTok) {
    let o = this.out.get(sinkId);
    if (!o) { o = { flat: [], n: 0 }; this.out.set(sinkId, o); }
    o.flat.push(callId, status, latUs, outTok);
    o.n++;
  }

  /**
   * Accept n calls for `name` from sink `sinkId`.
   * wallNow: Date.now() (limits + metrics); monoNow: performance.now() (scheduling).
   */
  submit(sinkId, name, n, ids, toks, wallNow, monoNow, payloadBytes = 0) {
    this.totals.calls += n;
    this.totals.payloadBytes += payloadBytes;
    const st = this.models.get(name);
    if (!st) {
      this.totals.unknownModel += n;
      for (let i = 0; i < n; i++) this._emit(sinkId, ids[i], S_PERMANENT, 0, 0);
      return;
    }
    if (this.lastMs < 0) this.lastMs = Math.floor(monoNow) - 1;
    const bucket = st.series.at(wallNow);
    const { limiter } = st;
    const rng = this.rng;
    const ratio = st.cfg.outputTokensRatio;
    for (let i = 0; i < n; i++) {
      const tokens = toks[i];
      if (!limiter.tryAcquire(tokens, wallNow)) {
        bucket[F_429]++;
        this.totals.rateLimited++;
        this._emit(sinkId, ids[i], S_RATE_LIMITED, 0, 0);
        continue;
      }
      bucket[F_ACC]++;
      bucket[F_ACC_TOK] += tokens;
      this.totals.accepted++;
      const r = rng.next();
      let status; let ms; let outTok = 0;
      if (r < st.pPerm) {
        status = S_PERMANENT; ms = this._sampleLatency(st, 0) * 0.1; bucket[F_PERM]++;
      } else if (r < st.pTrans) {
        status = S_TRANSIENT; ms = this._sampleLatency(st, 0) * 0.2; bucket[F_TR]++;
      } else if (r < st.pTimeout) {
        status = S_TIMEOUT; ms = st.cfg.outcomes.timeoutMs; bucket[F_TO]++;
      } else {
        status = S_OK; ms = this._sampleLatency(st, tokens); bucket[F_OK]++;
        outTok = Math.round(tokens * ratio);
      }
      let due = Math.ceil(monoNow + ms);
      if (due <= this.lastMs) due = this.lastMs + 1;
      this.wheel[due & MASK].push(sinkId, ids[i], status, Math.round(ms * 1000), outTok);
      this.wheelCount++;
    }
  }

  /** Release every call whose latency has elapsed, then flush results per sink. */
  tick(monoNow) {
    const nowMs = Math.floor(monoNow);
    if (this.lastMs < 0) this.lastMs = nowMs;
    if (this.wheelCount > 0) {
      let from = this.lastMs + 1;
      if (nowMs - from >= WHEEL) from = nowMs - WHEEL + 1;
      for (let ms = from; ms <= nowMs; ms++) {
        const slot = this.wheel[ms & MASK];
        if (slot.length === 0) continue;
        for (let j = 0; j < slot.length; j += 5) this._emit(slot[j], slot[j + 1], slot[j + 2], slot[j + 3], slot[j + 4]);
        this.wheelCount -= slot.length / 5;
        this.wheel[ms & MASK] = [];
      }
    }
    if (nowMs > this.lastMs) this.lastMs = nowMs;
    this.flush();
  }

  flush() {
    if (this.out.size === 0) return;
    for (const [sinkId, o] of this.out) {
      if (o.n > 0) this.onResults(sinkId, o.flat, o.n);
    }
    this.out.clear();
  }

  /** Drop pending results for a sink that disconnected. */
  dropSink(sinkId) {
    this.out.delete(sinkId);
  }

  pending() { return this.wheelCount; }

  metrics(sinceMs = 0) {
    const models = {};
    for (const [name, st] of this.models) models[name] = st.series.rows(sinceMs);
    return { models, totals: { ...this.totals, pending: this.wheelCount } };
  }

  resetMetrics() {
    for (const st of this.models.values()) st.series.clear();
    for (const k of Object.keys(this.totals)) this.totals[k] = 0;
  }
}
