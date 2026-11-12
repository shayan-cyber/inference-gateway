/**
 * Delivers batch-completion callbacks with retries.
 *
 * - Sent only from Engine._completeBatch, i.e. after every request is final.
 * - The body is built once and re-sent unchanged on every attempt, with an
 *   Idempotency-Key header (= batch id) so receivers can de-duplicate.
 * - Any non-2xx response, network error or timeout is retried with exponential
 *   backoff + jitter (base 1 s, doubling, capped) up to maxAttempts; after that the
 *   callback is marked `failed` and the batch is still queryable via the API.
 */
export class CallbackDispatcher {
  constructor(engine, opt) {
    this.engine = engine;
    this.opt = opt;
    this.active = 0;
    this.queue = [];
    this.timers = new Set();
    this.stopped = false;
    this.s = { callbacksDelivered: 0, callbacksFailed: 0, callbackAttempts: 0, callbacksPending: 0 };
  }

  enqueue(b) {
    const summary = this.engine.batchSummary(b);
    const body = { event: 'batch.completed', ...summary };
    if (b.n <= this.opt.inlineResultsMax) body.results = this.engine.results(b, 0, b.n).results;
    else body.results = null;
    b.callback.body = JSON.stringify(body);
    this.s.callbacksPending++;
    this._ready(b);
  }

  _ready(b) {
    this.queue.push(b);
    this._pump();
  }

  _pump() {
    while (!this.stopped && this.active < this.opt.concurrency && this.queue.length > 0) {
      const b = this.queue.shift();
      this.active++;
      this._attempt(b).finally(() => { this.active--; this._pump(); });
    }
  }

  async _attempt(b) {
    const cb = b.callback;
    const n = cb.attempts.length + 1;
    const started = Date.now();
    if (!cb.firstAttemptAt) {
      cb.firstAttemptAt = started;
      this.engine.histCallbackFirst.record(started - b.completedAt);
    }
    cb.state = 'delivering';
    this.s.callbackAttempts++;
    let status = 0;
    let error = null;
    try {
      const r = await fetch(b.callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': b.id,
          'x-batch-id': b.id,
          'x-callback-attempt': String(n),
        },
        body: cb.body,
        signal: AbortSignal.timeout(this.opt.timeoutMs),
      });
      status = r.status;
      await r.arrayBuffer().catch(() => {});
    } catch (e) {
      error = e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code || e.message);
    }
    const finished = Date.now();
    const ok = status >= 200 && status < 300;
    cb.attempts.push({
      attempt: n, at: new Date(started).toISOString(), status: status || null, error, duration_ms: finished - started,
    });
    if (ok) {
      cb.state = 'delivered';
      cb.deliveredAt = finished;
      cb.body = null;
      this.s.callbacksDelivered++;
      this.s.callbacksPending--;
      this.engine.histCallback.record(finished - b.completedAt);
      return;
    }
    if (n >= this.opt.maxAttempts) {
      cb.state = 'failed';
      cb.body = null;
      this.s.callbacksFailed++;
      this.s.callbacksPending--;
      return;
    }
    cb.state = 'pending';
    const delay = Math.min(this.opt.maxDelayMs, this.opt.baseDelayMs * 2 ** (n - 1)) * (0.8 + Math.random() * 0.4);
    cb.nextAttemptAt = new Date(finished + delay).toISOString();
    const t = setTimeout(() => { this.timers.delete(t); this._ready(b); }, delay);
    this.timers.add(t);
  }

  stats() { return { ...this.s }; }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
  }
}
