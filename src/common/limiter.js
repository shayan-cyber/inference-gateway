/**
 * Rate limiting primitives shared by the gateway (to stay under limits) and the
 * provider simulator (to enforce them).
 *
 * SlidingWindow: a trailing-60s counter built from fixed buckets (default 100 ms).
 * The sum covers ceil(window/bucket)+1 buckets, i.e. slightly MORE than 60 s, so a
 * check `sum + x <= limit` is conservative: no 60-second period, however it is
 * aligned, can contain more than `limit` units admitted through this check.
 */
export class SlidingWindow {
  constructor(windowMs = 60_000, bucketMs = 100) {
    this.bucketMs = bucketMs;
    this.size = Math.ceil(windowMs / bucketMs) + 1;
    this.counts = new Float64Array(this.size);
    this.head = -1; // absolute index of the newest bucket
    this.total = 0;
  }

  _advance(now) {
    const b = Math.floor(now / this.bucketMs);
    if (b <= this.head) return;
    if (this.head < 0 || b - this.head >= this.size) {
      this.counts.fill(0);
      this.total = 0;
    } else {
      for (let k = this.head + 1; k <= b; k++) {
        const i = k % this.size;
        this.total -= this.counts[i];
        this.counts[i] = 0;
      }
      if (this.total < 1e-9) this.total = 0;
    }
    this.head = b;
  }

  sum(now) {
    this._advance(now);
    return this.total;
  }

  add(now, x) {
    this._advance(now);
    this.counts[this.head % this.size] += x;
    this.total += x;
  }
}

/**
 * Per-model limiter over two dimensions (requests and tokens).
 *
 * Two layers:
 *  1. Pacing (optional): token buckets refilling at utilization * limit / 60 s with a
 *     small burst. This spreads traffic evenly instead of spending the whole minute's
 *     budget in the first second.
 *  2. Hard guard (always): strict trailing-60s sliding windows for RPM and TPM. A unit
 *     is admitted only if the window plus this unit stays within the *current* limit.
 *     The guard alone is what makes the "never exceed" guarantee; pacing just keeps
 *     the guard from ever being the thing that binds in steady state.
 *
 * When limits drop, the guard applies immediately: if the trailing minute already
 * holds more than the new limit, nothing is admitted until enough of it ages out.
 */
export class ModelLimiter {
  constructor({
    rpm, tpm, pacing = true, utilization = 0.98, burstMs = 250, windowMs = 60_000, bucketMs = 100,
  }) {
    this.pacing = pacing;
    this.utilization = utilization;
    this.burstMs = burstMs;
    this.reqWin = new SlidingWindow(windowMs, bucketMs);
    this.tokWin = new SlidingWindow(windowMs, bucketMs);
    this.windowMs = windowMs;
    this.reqLevel = 0;
    this.tokLevel = 0;
    this.last = 0;
    this.initialized = false;
    this.setLimits(rpm, tpm);
  }

  setLimits(rpm, tpm) {
    this.rpm = Math.max(0, rpm);
    this.tpm = Math.max(0, tpm);
    this.reqRate = (this.rpm * this.utilization) / this.windowMs; // per ms
    this.tokRate = (this.tpm * this.utilization) / this.windowMs;
    this.reqCap = Math.max(1, this.reqRate * this.burstMs);
    this.tokCap = Math.max(1, this.tokRate * this.burstMs);
    if (this.reqLevel > this.reqCap) this.reqLevel = this.reqCap;
    if (this.tokLevel > this.tokCap) this.tokLevel = this.tokCap;
  }

  _refill(now) {
    if (!this.initialized) {
      this.initialized = true;
      this.last = now;
      this.reqLevel = this.reqCap;
      this.tokLevel = this.tokCap;
      return;
    }
    const dt = now - this.last;
    if (dt <= 0) return;
    this.last = now;
    this.reqLevel = Math.min(this.reqCap, this.reqLevel + dt * this.reqRate);
    this.tokLevel = Math.min(this.tokCap, this.tokLevel + dt * this.tokRate);
  }

  /** Admit one request of `tokens` at time `now` (ms). Returns true if admitted. */
  tryAcquire(tokens, now) {
    if (this.pacing) {
      this._refill(now);
      // A request larger than the token bucket may still pass once the bucket is full;
      // the bucket then goes negative and repays the debt before admitting more.
      if (this.reqLevel < 1 || this.tokLevel < Math.min(tokens, this.tokCap)) return false;
    }
    if (this.reqWin.sum(now) + 1 > this.rpm) return false;
    if (this.tokWin.sum(now) + tokens > this.tpm) return false;
    if (this.pacing) {
      this.reqLevel -= 1;
      this.tokLevel -= tokens;
    }
    this.reqWin.add(now, 1);
    this.tokWin.add(now, tokens);
    return true;
  }

  /** Requests and tokens used in the trailing window (conservative, see SlidingWindow). */
  usage(now) {
    return { requests: this.reqWin.sum(now), tokens: this.tokWin.sum(now) };
  }

  /** Sustained admission rate in requests/ms implied by the current limits. */
  sustainedReqPerMs(avgTokens = 0) {
    const byReq = this.reqRate;
    const byTok = avgTokens > 0 ? this.tokRate / avgTokens : Infinity;
    return Math.min(byReq, byTok);
  }
}
