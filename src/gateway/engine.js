import { ModelLimiter } from '../common/limiter.js';
import { Histogram } from '../common/histogram.js';
import { BucketSeries } from '../common/series.js';
import { isoTime } from '../common/util.js';
import {
  S_OK, S_RATE_LIMITED, S_PERMANENT,
} from '../common/proto.js';
import { Deque } from './deque.js';
import { CallbackDispatcher } from './callbacks.js';
import { InflightTable } from './inflight.js';

// ---- request states -------------------------------------------------------------
export const QUEUED = 0;
export const INFLIGHT = 1;
export const RETRY_WAIT = 2;
export const SUCCEEDED = 3;
export const FAILED = 4;
export const EXPIRED = 5;
export const REJECTED = 6; // refused at admission (model over capacity); never queued
export const STATE_NAMES = ['queued', 'in_flight', 'retry_wait', 'succeeded', 'failed', 'expired', 'rejected'];

export const E_NONE = 0;
export const E_PERMANENT = 1;
export const E_RETRIES = 2;
export const E_DEADLINE = 3;
export const E_OVER_CAPACITY = 4;
export const ERROR_NAMES = [null, 'provider_permanent_error', 'retries_exhausted', 'deadline_exceeded', 'model_over_capacity'];

/** Per-model, per-second series exported for reports and the dashboard. */
export const MODEL_FIELDS = [
  'accepted', 'rejected', 'dispatched', 'dispatched_tokens', 'succeeded', 'failed', 'expired',
  'retried', 'rate_limited', 'queue_depth', 'inflight', 'limit_rpm', 'limit_tpm',
];
const F = Object.fromEntries(MODEL_FIELDS.map((f, i) => [f, i]));
/** How each field merges across shards: counters/gauges sum, configured limits take max. */
export const MODEL_FIELD_MERGE = { [F.limit_rpm]: 'max', [F.limit_tpm]: 'max' };

export const DEFAULT_ENGINE_OPTIONS = {
  tickMs: 1,
  maxDispatchPerTick: 50_000,
  utilization: 0.98,
  burstMs: 250,
  maxQueueWaitMs: 30_000,
  maxQueueDepth: 5_000_000,
  defaultTtlMs: 120_000,
  maxTtlMs: 3_600_000,
  maxAttempts: 4,
  retryBaseMs: 100,
  retryMaxMs: 5_000,
  rateLimitBackoffMs: 250,
  callTimeoutMs: 65_000,
  maxBatchSize: 100_000,
  resultRetentionMs: 3_600_000,
  maxRetainedRequests: 20_000_000,
  publicBaseUrl: '',
  callback: {
    maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 60_000, timeoutMs: 10_000, concurrency: 64, inlineResultsMax: 10_000,
  },
};

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}

/**
 * One engine shard. Owns:
 *   - a FIFO queue, a limiter and stats per model
 *   - every request it accepted, from acceptance to a final state
 *   - an in-flight table keyed by provider call id
 *   - a retry wheel for transient failures and provider 429s
 *   - callback delivery for completed batches
 *
 * Shards are independent; each holds 1/shardCount of every model's limit.
 */
export class Engine {
  constructor({
    shardId = 0, shardCount = 1, models = [], provider, options = {}, onEvent = () => {},
  }) {
    this.shardId = shardId;
    this.shardCount = shardCount;
    this.opt = { ...DEFAULT_ENGINE_OPTIONS, ...options, callback: { ...DEFAULT_ENGINE_OPTIONS.callback, ...(options.callback || {}) } };
    this.provider = provider;
    this.onEvent = onEvent;
    this.models = new Map();
    this.modelList = [];
    for (const m of models) this.upsertModel(m);

    this.batches = new Map(); // id -> batch (batches and single requests)
    this.inflight = new InflightTable(); // callId -> (batch, index, sentAt)
    this._onTaken = (b, i, t) => this._onResult(b, i, t);
    this._st = 0;
    this._out = 0;
    this.seq = 0;
    this.retryWheel = new Map(); // 10 ms bucket -> [b, i, b, i, ...]
    this.retryCursor = Math.floor(Date.now() / 10);
    this.retryWaiting = 0;
    this.completedOrder = new Deque(256);
    this.retained = 0;
    this.rr = 0;

    this.totals = {
      accepted: 0, rejected: 0, succeeded: 0, failed: 0, expired: 0, dispatched: 0, retried: 0,
      rateLimited: 0, lateResults: 0, providerDisconnects: 0, batchesAccepted: 0, batchesRejected: 0, batchesPartiallyRejected: 0,
      batchesCompleted: 0, evictedBatches: 0,
    };
    this.histE2e = new Histogram(); // acceptance -> final state (includes queueing)
    this.histRtt = new Histogram(); // final provider call: dispatch -> provider answer
    this.histBatch = new Histogram(); // batch accepted -> last request final
    this.histCallback = new Histogram(); // batch complete -> callback delivered (2xx)
    this.histCallbackFirst = new Histogram(); // batch complete -> first callback attempt
    this.callbacks = new CallbackDispatcher(this, this.opt.callback);
    this.lastHousekeeping = 0;
    this.running = false;
    if (provider) provider.attach(this);
  }

  // ---- models & limits -----------------------------------------------------------

  /** cfg: { name, providerRpm, providerTpm, capRpm?, capTpm? } (global, pre-sharding). */
  upsertModel(cfg) {
    let m = this.models.get(cfg.name);
    if (!m) {
      m = {
        name: cfg.name,
        idx: this.modelList.length,
        providerRpm: 0,
        providerTpm: 0,
        capRpm: Infinity,
        capTpm: Infinity,
        limiter: null,
        queue: new Deque(1024),
        queuedTokens: 0,
        inflight: 0,
        pausedUntil: 0,
        hist: new Histogram(),
        series: new BucketSeries(MODEL_FIELDS, 1000, 7200),
      };
      this.models.set(m.name, m);
      this.modelList.push(m);
    }
    if (cfg.providerRpm !== undefined) m.providerRpm = cfg.providerRpm;
    if (cfg.providerTpm !== undefined) m.providerTpm = cfg.providerTpm;
    if (cfg.capRpm !== undefined) m.capRpm = cfg.capRpm ?? Infinity;
    if (cfg.capTpm !== undefined) m.capTpm = cfg.capTpm ?? Infinity;
    if (m.capRpm === null) m.capRpm = Infinity;
    if (m.capTpm === null) m.capTpm = Infinity;
    m.effRpm = Math.min(m.providerRpm, m.capRpm);
    m.effTpm = Math.min(m.providerTpm, m.capTpm);
    const rpm = m.effRpm / this.shardCount;
    const tpm = m.effTpm / this.shardCount;
    if (!m.limiter) {
      m.limiter = new ModelLimiter({
        rpm, tpm, utilization: this.opt.utilization, burstMs: this.opt.burstMs,
      });
    } else m.limiter.setLimits(rpm, tpm);
    return m;
  }

  // ---- submission ---------------------------------------------------------------

  /**
   * Validate and accept a single request or a batch. Throws HttpError on rejection.
   * Returns the internal batch object (a single request is a batch of one).
   */
  submit(body, kind, now = Date.now()) {
    if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_body', 'body must be a JSON object');
    const reqs = kind === 'single' ? [body] : body.requests;
    if (!Array.isArray(reqs) || reqs.length === 0) throw new HttpError(400, 'invalid_body', '`requests` must be a non-empty array');
    const n = reqs.length;
    if (n > this.opt.maxBatchSize) throw new HttpError(413, 'batch_too_large', `batch size ${n} exceeds ${this.opt.maxBatchSize}`);

    let callbackUrl = null;
    if (kind === 'batch' && body.callback_url != null) {
      try {
        const u = new URL(body.callback_url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
        callbackUrl = u.toString();
      } catch {
        throw new HttpError(400, 'invalid_callback_url', 'callback_url must be an absolute http(s) URL');
      }
    }
    const ttlRaw = kind === 'single' ? body.ttl_ms : body.ttl_ms;
    const ttl = ttlRaw == null ? this.opt.defaultTtlMs : Math.min(this.opt.maxTtlMs, Math.max(1000, Number(ttlRaw) || 0));
    const maxAttemptsRaw = body.max_attempts;
    const maxAttempts = maxAttemptsRaw == null ? this.opt.maxAttempts : Math.min(10, Math.max(1, Math.floor(Number(maxAttemptsRaw) || 1)));

    const modelIdx = new Uint16Array(n);
    const tokens = new Uint32Array(n);
    const payloads = new Array(n);
    let ids = null;
    let seen = null;
    const perModel = new Float64Array(this.modelList.length);
    const perModelTok = new Float64Array(this.modelList.length);
    for (let i = 0; i < n; i++) {
      const r = reqs[i];
      if (!r || typeof r !== 'object') throw new HttpError(400, 'invalid_request', `requests[${i}] must be an object`);
      const m = this.models.get(r.model);
      if (!m) throw new HttpError(400, 'unknown_model', `requests[${i}].model "${r.model}" is not a configured model`);
      const t = r.estimated_tokens;
      if (!Number.isInteger(t) || t <= 0 || t > 0xffffffff) {
        throw new HttpError(400, 'invalid_tokens', `requests[${i}].estimated_tokens must be a positive integer`);
      }
      if (m.effTpm > 0 && t > m.effTpm / this.shardCount) {
        throw new HttpError(400, 'exceeds_model_tpm', `requests[${i}].estimated_tokens (${t}) can never fit in ${m.name}'s TPM limit`);
      }
      const rid = r.request_id;
      if (rid != null) {
        if (typeof rid !== 'string' || rid.length === 0 || rid.length > 256) {
          throw new HttpError(400, 'invalid_request_id', `requests[${i}].request_id must be a non-empty string (<=256 chars)`);
        }
        if (!ids) { ids = new Array(n).fill(null); seen = new Set(); }
        if (seen.has(rid)) throw new HttpError(400, 'duplicate_request_id', `requests[${i}].request_id "${rid}" is duplicated in this batch`);
        seen.add(rid);
        ids[i] = rid;
      }
      modelIdx[i] = m.idx;
      tokens[i] = t;
      perModel[m.idx]++;
      perModelTok[m.idx] += t;
      const p = r.payload;
      payloads[i] = p === undefined ? undefined : (typeof p === 'string' ? p : JSON.stringify(p));
    }

    // Admission control, per model: refuse work for a model whose existing backlog would
    // already take longer than maxQueueWaitMs to drain at its current sustainable rate.
    // Only the congested model's requests are refused (state `rejected` inside the
    // batch), so one constrained model never blocks the others. A batch is refused
    // outright (429) only if nothing in it can be accepted, or the client asked for
    // admission: "all_or_nothing".
    let congested = null;
    let rejectN = 0;
    for (let k = 0; k < perModel.length; k++) {
      if (perModel[k] === 0) continue;
      const m = this.modelList[k];
      let reason = null; let retryAfter = 1;
      if (m.queue.length + perModel[k] > this.opt.maxQueueDepth) reason = 'queue_full';
      else if (m.queue.length > 0) {
        const eta = this._etaMs(m, m.queue.length, m.queuedTokens);
        if (eta > this.opt.maxQueueWaitMs) {
          reason = m.effRpm === 0 || m.effTpm === 0 ? 'model_paused' : 'over_capacity';
          retryAfter = Number.isFinite(eta) ? Math.ceil((eta - this.opt.maxQueueWaitMs) / 1000) : 60;
        }
      }
      if (reason) {
        (congested ||= new Map()).set(k, { reason, retry_after_s: Math.max(1, Math.min(3600, retryAfter)), requests: perModel[k] });
        rejectN += perModel[k];
      }
    }
    if (congested && (rejectN === n || kind === 'single' || body.admission === 'all_or_nothing')) {
      this.totals.rejected += n;
      this.totals.batchesRejected++;
      for (let k = 0; k < perModel.length; k++) if (perModel[k]) this.modelList[k].series.add(now, F.rejected, perModel[k]);
      const [k0, c0] = congested.entries().next().value;
      throw new HttpError(429, c0.reason, `model ${this.modelList[k0].name} cannot take more work right now (${c0.reason}); retry later`, {
        retry_after_s: Math.max(...[...congested.values()].map((c) => c.retry_after_s)),
        rejected_by_model: Object.fromEntries([...congested].map(([k, c]) => [this.modelList[k].name, c])),
      });
    }

    const prefix = kind === 'single' ? 'r' : 'b';
    const id = `${prefix}${this.shardId}_${(++this.seq).toString(36)}${Math.floor(Math.random() * 1679616).toString(36).padStart(4, '0')}`;
    if (ids && seen) {
      for (let i = 0; i < n; i++) {
        if (ids[i] === null) {
          const gen = `${id}-${i}`;
          if (seen.has(gen)) throw new HttpError(400, 'duplicate_request_id', `request id ${gen} collides with a generated id`);
        }
      }
    }
    const b = {
      id,
      kind,
      n,
      ids,
      modelIdx,
      tokens,
      payloads,
      state: new Uint8Array(n), // all QUEUED
      attempts: new Uint8Array(n),
      err: new Uint8Array(n),
      latency: new Float32Array(n),
      outTokens: new Uint32Array(n),
      counts: new Int32Array(7),
      remaining: n - rejectN,
      rejectedByModel: congested ? Object.fromEntries([...congested].map(([k, c]) => [this.modelList[k].name, c])) : null,
      createdAt: now,
      deadline: now + ttl,
      maxAttempts,
      completedAt: 0,
      callbackUrl,
      callback: callbackUrl ? { state: 'pending', attempts: [], deliveredAt: 0, firstAttemptAt: 0 } : null,
      metadata: kind === 'batch' && body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
      waiters: null,
      evicted: false,
    };
    b.counts[QUEUED] = n - rejectN;
    b.counts[REJECTED] = rejectN;
    for (let i = 0; i < n; i++) {
      if (congested && congested.has(modelIdx[i])) {
        b.state[i] = REJECTED;
        b.err[i] = E_OVER_CAPACITY;
        payloads[i] = undefined;
        continue;
      }
      const m = this.modelList[modelIdx[i]];
      m.queue.push(b, i);
      m.queuedTokens += tokens[i];
    }
    for (let k = 0; k < perModel.length; k++) {
      if (!perModel[k]) continue;
      this.modelList[k].series.add(now, congested && congested.has(k) ? F.rejected : F.accepted, perModel[k]);
    }
    this.batches.set(id, b);
    this.retained += n;
    this.totals.accepted += n - rejectN;
    this.totals.rejected += rejectN;
    if (kind === 'batch') this.totals.batchesAccepted++;
    if (rejectN) this.totals.batchesPartiallyRejected++;
    return b;
  }

  _etaMs(m, qLen, qTok) {
    const reqRate = m.limiter.reqRate; // per ms, this shard
    const tokRate = m.limiter.tokRate;
    const a = reqRate > 0 ? qLen / reqRate : Infinity;
    const c = tokRate > 0 ? qTok / tokRate : Infinity;
    return Math.max(a, c);
  }

  // ---- dispatch loop ---------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      const busy = this.tick();
      if (busy) setImmediate(loop); else setTimeout(loop, this.opt.tickMs);
    };
    loop();
  }

  stop() { this.running = false; this.callbacks.stop(); }

  /** One dispatch pass. Returns true if it stopped because of the per-tick budget. */
  tick(now = Date.now()) {
    if (this.provider.poll) this.provider.poll();
    this._processRetries(now);
    let budget = this.opt.maxDispatchPerTick;
    const L = this.modelList.length;
    const start = this.rr++ % Math.max(1, L);
    for (let k = 0; k < L && budget > 0; k++) {
      const m = this.modelList[(start + k) % L];
      const q = m.queue;
      while (q.length > 0 && budget > 0) {
        const b = q.peekObj();
        const i = q.peekNum();
        if (now > b.deadline) {
          q.shift();
          m.queuedTokens -= b.tokens[i];
          this._finalize(b, i, EXPIRED, E_DEADLINE, now, m);
          continue;
        }
        if (!this.provider.ready || now < m.pausedUntil) break;
        const t = b.tokens[i];
        if (!m.limiter.tryAcquire(t, now)) break;
        q.shift();
        m.queuedTokens -= t;
        this._dispatch(b, i, m, t, now);
        budget--;
      }
    }
    this.provider.flush();
    if (now - this.lastHousekeeping >= 1000) {
      this.lastHousekeeping = now;
      this._housekeeping(now);
    }
    return budget === 0;
  }

  _setState(b, i, s) {
    b.counts[b.state[i]]--;
    b.state[i] = s;
    b.counts[s]++;
  }

  _dispatch(b, i, m, t, now) {
    this._setState(b, i, INFLIGHT);
    b.attempts[i]++;
    const callId = this.inflight.add(b, i, now);
    m.inflight++;
    this.provider.enqueue(m, callId, t, b.payloads[i]);
    this.totals.dispatched++;
    const row = m.series.at(now);
    row[F.dispatched]++;
    row[F.dispatched_tokens] += t;
  }

  /** Provider answered call `callId`. */
  onResult(callId, status, latUs, outTok) {
    this._st = status; this._out = outTok;
    if (!this.inflight.take(callId, this._onTaken)) this.totals.lateResults++;
  }

  _onResult(b, i, sentAt) {
    const status = this._st;
    const outTok = this._out;
    const m = this.modelList[b.modelIdx[i]];
    m.inflight--;
    const now = Date.now();
    if (status === S_OK) {
      b.outTokens[i] = outTok;
      this.histRtt.record(now - sentAt);
      this._finalize(b, i, SUCCEEDED, E_NONE, now, m);
    } else if (status === S_PERMANENT) {
      this.histRtt.record(now - sentAt);
      this._finalize(b, i, FAILED, E_PERMANENT, now, m);
    } else if (status === S_RATE_LIMITED) {
      // The provider is tighter than we believed (limits just changed, or skew).
      // Not the request's fault: do not burn an attempt, back off the whole model,
      // and ask for a fresh view of the limits.
      b.attempts[i]--;
      this.totals.rateLimited++;
      m.series.add(now, F.rate_limited);
      if (m.pausedUntil < now) {
        m.pausedUntil = now + this.opt.rateLimitBackoffMs;
        this.onEvent({ type: 'rate_limited', model: m.name });
      }
      this._scheduleRetry(b, i, m, now + this.opt.rateLimitBackoffMs + Math.random() * 100, now);
    } else {
      this._transientFailure(b, i, m, now, sentAt);
    }
  }

  _transientFailure(b, i, m, now, sentAt) {
    if (b.attempts[i] >= b.maxAttempts) {
      this.histRtt.record(now - sentAt);
      this._finalize(b, i, FAILED, E_RETRIES, now, m);
      return;
    }
    this.totals.retried++;
    m.series.add(now, F.retried);
    const backoff = Math.min(this.opt.retryMaxMs, this.opt.retryBaseMs * 2 ** (b.attempts[i] - 1));
    this._scheduleRetry(b, i, m, now + backoff * (0.5 + Math.random()), now);
  }

  _scheduleRetry(b, i, m, due, now) {
    if (due > b.deadline) {
      this._finalize(b, i, EXPIRED, E_DEADLINE, now, m);
      return;
    }
    this._setState(b, i, RETRY_WAIT);
    let k = Math.ceil(due / 10);
    if (k <= this.retryCursor) k = this.retryCursor + 1;
    let arr = this.retryWheel.get(k);
    if (!arr) { arr = []; this.retryWheel.set(k, arr); }
    arr.push(b, i);
    this.retryWaiting++;
  }

  _processRetries(now) {
    const target = Math.floor(now / 10);
    if (this.retryWaiting === 0) { this.retryCursor = target; return; }
    for (let k = this.retryCursor + 1; k <= target; k++) {
      const arr = this.retryWheel.get(k);
      if (!arr) continue;
      this.retryWheel.delete(k);
      // Requeue at the FRONT: retries are the oldest work for their model.
      for (let j = arr.length - 2; j >= 0; j -= 2) {
        const b = arr[j];
        const i = arr[j + 1];
        this.retryWaiting--;
        if (b.state[i] !== RETRY_WAIT) continue;
        const m = this.modelList[b.modelIdx[i]];
        this._setState(b, i, QUEUED);
        m.queue.unshift(b, i);
        m.queuedTokens += b.tokens[i];
      }
    }
    this.retryCursor = target;
  }

  _finalize(b, i, state, err, now, m) {
    this._setState(b, i, state);
    b.err[i] = err;
    const lat = now - b.createdAt;
    b.latency[i] = lat;
    b.payloads[i] = undefined;
    b.remaining--;
    const row = m.series.at(now);
    if (state === SUCCEEDED) { this.totals.succeeded++; row[F.succeeded]++; } else if (state === FAILED) { this.totals.failed++; row[F.failed]++; } else { this.totals.expired++; row[F.expired]++; }
    if (state !== EXPIRED) {
      this.histE2e.record(lat);
      m.hist.record(lat);
    }
    if (b.remaining === 0) this._completeBatch(b, now);
  }

  _completeBatch(b, now) {
    b.completedAt = now;
    b.payloads = null;
    if (b.kind === 'batch') {
      this.totals.batchesCompleted++;
      this.histBatch.record(now - b.createdAt);
    }
    this.completedOrder.push(b);
    if (b.waiters) {
      for (const w of b.waiters) w(b);
      b.waiters = null;
    }
    if (b.callbackUrl) this.callbacks.enqueue(b);
  }

  /** Provider connection dropped: every in-flight call is retried as a transient failure. */
  onProviderDisconnect() {
    const now = Date.now();
    this.totals.providerDisconnects++;
    this.inflight.removeWhere(() => true, (b, i, t) => {
      const m = this.modelList[b.modelIdx[i]];
      m.inflight--;
      this._transientFailure(b, i, m, now, t);
    });
  }

  _housekeeping(now) {
    // Calls the provider never answered.
    const cutoff = now - this.opt.callTimeoutMs;
    this.inflight.removeWhere((b, i, t) => t <= cutoff, (b, i, t) => {
      const m = this.modelList[b.modelIdx[i]];
      m.inflight--;
      this._transientFailure(b, i, m, now, t);
    });
    // Gauges.
    for (const m of this.modelList) {
      const row = m.series.at(now);
      row[F.queue_depth] = m.queue.length;
      row[F.inflight] = m.inflight;
      row[F.limit_rpm] = m.effRpm;
      row[F.limit_tpm] = m.effTpm;
    }
    // Result retention.
    const q = this.completedOrder;
    while (q.length > 0) {
      const b = q.peekObj();
      const old = now - b.completedAt > this.opt.resultRetentionMs;
      const over = this.retained > this.opt.maxRetainedRequests;
      if (!old && !over) break;
      if (b.callback && (b.callback.state === 'pending' || b.callback.state === 'delivering')) break;
      q.shift();
      this.batches.delete(b.id);
      b.evicted = true;
      this.retained -= b.n;
      this.totals.evictedBatches++;
    }
  }

  // ---- views ---------------------------------------------------------------------

  requestIdAt(b, i) {
    return b.ids && b.ids[i] !== null ? b.ids[i] : (b.kind === 'single' ? b.id : `${b.id}-${i}`);
  }

  batchStatus(b) {
    if (b.remaining > 0) return 'processing';
    const ok = b.counts[SUCCEEDED];
    if (ok === b.n) return 'completed';
    if (ok === 0) return 'failed';
    return 'completed_with_failures';
  }

  /** Summary shared by GET /v1/batches/:id and the completion callback. */
  batchSummary(b) {
    const c = b.counts;
    const base = this.opt.publicBaseUrl;
    return {
      batch_id: b.id,
      status: this.batchStatus(b),
      total: b.n,
      succeeded: c[SUCCEEDED],
      failed: c[FAILED] + c[EXPIRED] + c[REJECTED],
      failure_breakdown: { provider_or_retries: c[FAILED], expired: c[EXPIRED], rejected_at_admission: c[REJECTED] },
      waiting: c[QUEUED] + c[INFLIGHT] + c[RETRY_WAIT],
      counts: {
        queued: c[QUEUED], in_flight: c[INFLIGHT], retry_wait: c[RETRY_WAIT], succeeded: c[SUCCEEDED], failed: c[FAILED], expired: c[EXPIRED], rejected: c[REJECTED],
      },
      rejected_by_model: b.rejectedByModel || undefined,
      created_at: isoTime(b.createdAt),
      completed_at: isoTime(b.completedAt),
      duration_ms: b.completedAt ? b.completedAt - b.createdAt : null,
      deadline_at: isoTime(b.deadline),
      metadata: b.metadata,
      results_url: `${base}/v1/batches/${b.id}/results`,
    };
  }

  batchView(b) {
    const s = this.batchSummary(b);
    if (b.callback) {
      const cb = b.callback;
      const last = cb.attempts[cb.attempts.length - 1];
      s.callback = {
        url: b.callbackUrl,
        state: cb.state,
        attempts: cb.attempts.length,
        last_attempt: last || null,
        first_attempt_at: isoTime(cb.firstAttemptAt),
        delivered_at: isoTime(cb.deliveredAt),
        history: cb.attempts,
      };
    }
    return s;
  }

  resultItem(b, i) {
    const s = b.state[i];
    return {
      request_id: this.requestIdAt(b, i),
      model: this.modelList[b.modelIdx[i]].name,
      status: STATE_NAMES[s],
      attempts: b.attempts[i],
      estimated_tokens: b.tokens[i],
      latency_ms: s >= SUCCEEDED && s !== REJECTED ? Math.round(b.latency[i] * 10) / 10 : null,
      output_tokens: s === SUCCEEDED ? b.outTokens[i] : null,
      error: ERROR_NAMES[b.err[i]],
    };
  }

  results(b, offset = 0, limit = 10_000) {
    const end = Math.min(b.n, offset + limit);
    const items = [];
    for (let i = offset; i < end; i++) items.push(this.resultItem(b, i));
    return {
      batch_id: b.id, total: b.n, offset, limit, next_offset: end < b.n ? end : null, results: items,
    };
  }

  requestView(b) {
    const item = this.resultItem(b, 0);
    return {
      id: b.id,
      ...item,
      created_at: isoTime(b.createdAt),
      completed_at: isoTime(b.completedAt),
      deadline_at: isoTime(b.deadline),
    };
  }

  // ---- stats -----------------------------------------------------------------------

  exportStats(sinceMs = 0, withSeries = false) {
    const models = {};
    for (const m of this.modelList) {
      models[m.name] = {
        provider_rpm: m.providerRpm,
        provider_tpm: m.providerTpm,
        cap_rpm: Number.isFinite(m.capRpm) ? m.capRpm : null,
        cap_tpm: Number.isFinite(m.capTpm) ? m.capTpm : null,
        effective_rpm: m.effRpm,
        effective_tpm: m.effTpm,
        queue_depth: m.queue.length,
        inflight: m.inflight,
        paused: Date.now() < m.pausedUntil,
        window: m.limiter.usage(Date.now()),
        hist: m.hist.toJSON(),
        series: withSeries ? m.series.rows(sinceMs) : undefined,
      };
    }
    const cb = this.callbacks.stats();
    return {
      shard: this.shardId,
      totals: { ...this.totals, inflight: this.inflight.size, retryWaiting: this.retryWaiting, retainedRequests: this.retained, ...cb },
      hist: {
        e2e: this.histE2e.toJSON(),
        rtt: this.histRtt.toJSON(),
        batch: this.histBatch.toJSON(),
        callback: this.histCallback.toJSON(),
        callbackFirst: this.histCallbackFirst.toJSON(),
      },
      models,
    };
  }
}

export { HttpError };
