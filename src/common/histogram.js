/**
 * Log-linear latency histogram (HDR-style, 32 sub-buckets per power of two).
 * Values are recorded in milliseconds and stored in microsecond buckets; relative
 * error is at most ~3%. Histograms are mergeable, so per-shard histograms can be
 * combined into one exact-bucket aggregate.
 */
const SUB_BITS = 5;
const SUB = 1 << SUB_BITS; // 32
const MAX_EXP = 31;
const SIZE = SUB + (MAX_EXP - SUB_BITS + 1) * SUB;

function indexOf(us) {
  if (us < SUB) return us;
  const e = 31 - Math.clz32(us);
  return SUB + (e - SUB_BITS) * SUB + ((us >>> (e - SUB_BITS)) - SUB);
}

function lowerBound(idx) {
  if (idx < SUB) return idx;
  const e = Math.floor((idx - SUB) / SUB) + SUB_BITS;
  const sub = (idx - SUB) % SUB;
  return (SUB + sub) * 2 ** (e - SUB_BITS);
}

function width(idx) {
  if (idx < SUB) return 1;
  const e = Math.floor((idx - SUB) / SUB) + SUB_BITS;
  return 2 ** (e - SUB_BITS);
}

export class Histogram {
  constructor() {
    this.counts = new Float64Array(SIZE);
    this.n = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = 0;
  }

  record(ms) {
    if (!(ms >= 0)) return;
    let us = Math.round(ms * 1000);
    if (us > 0x7fffffff) us = 0x7fffffff;
    this.counts[indexOf(us)]++;
    this.n++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }

  merge(other) {
    const o = other instanceof Histogram ? other : Histogram.fromJSON(other);
    for (let i = 0; i < SIZE; i++) this.counts[i] += o.counts[i];
    this.n += o.n;
    this.sum += o.sum;
    if (o.min < this.min) this.min = o.min;
    if (o.max > this.max) this.max = o.max;
    return this;
  }

  percentile(p) {
    if (this.n === 0) return null;
    const target = Math.max(1, Math.ceil((p / 100) * this.n));
    let acc = 0;
    for (let i = 0; i < SIZE; i++) {
      acc += this.counts[i];
      if (acc >= target) {
        const mid = (lowerBound(i) + width(i) / 2) / 1000;
        return Math.min(Math.max(mid, this.min), this.max);
      }
    }
    return this.max;
  }

  summary() {
    if (this.n === 0) return { count: 0, mean: null, p50: null, p95: null, p99: null, max: null };
    const r = (x) => Math.round(x * 100) / 100;
    return {
      count: this.n,
      mean: r(this.sum / this.n),
      p50: r(this.percentile(50)),
      p95: r(this.percentile(95)),
      p99: r(this.percentile(99)),
      max: r(this.max),
    };
  }

  toJSON() {
    const sparse = [];
    for (let i = 0; i < SIZE; i++) if (this.counts[i]) sparse.push(i, this.counts[i]);
    return { b: sparse, n: this.n, sum: this.sum, min: this.n ? this.min : null, max: this.max };
  }

  static fromJSON(j) {
    const h = new Histogram();
    if (!j) return h;
    for (let k = 0; k < j.b.length; k += 2) h.counts[j.b[k]] = j.b[k + 1];
    h.n = j.n; h.sum = j.sum; h.min = j.min ?? Infinity; h.max = j.max;
    return h;
  }
}
