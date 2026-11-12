/**
 * Fixed-width time buckets of numeric fields (e.g. per-second counters).
 * Buckets are keyed by absolute index floor(ms / bucketMs) and kept in insertion
 * order, so the oldest is evicted first once `keep` buckets exist.
 */
export class BucketSeries {
  constructor(fields, bucketMs = 1000, keep = 3600) {
    this.fields = fields;
    this.F = fields.length;
    this.bucketMs = bucketMs;
    this.keep = keep;
    this.map = new Map();
    this.cur = -1;
    this.curArr = null;
    this.index = Object.fromEntries(fields.map((f, i) => [f, i]));
  }

  at(nowMs) {
    const k = Math.floor(nowMs / this.bucketMs);
    if (k !== this.cur) {
      this.cur = k;
      let a = this.map.get(k);
      if (!a) {
        a = new Float64Array(this.F);
        this.map.set(k, a);
        if (this.map.size > this.keep) this.map.delete(this.map.keys().next().value);
      }
      this.curArr = a;
    }
    return this.curArr;
  }

  add(nowMs, f, v = 1) { this.at(nowMs)[f] += v; }

  set(nowMs, f, v) { this.at(nowMs)[f] = v; }

  /** Rows of [bucketStartMs, ...fields] for buckets starting at or after sinceMs. */
  rows(sinceMs = 0) {
    const out = [];
    const since = Math.floor(sinceMs / this.bucketMs);
    for (const [k, a] of this.map) {
      if (k < since) continue;
      const row = new Array(this.F + 1);
      row[0] = k * this.bucketMs;
      for (let i = 0; i < this.F; i++) row[i + 1] = a[i];
      out.push(row);
    }
    return out;
  }

  clear() {
    this.map.clear();
    this.cur = -1;
    this.curArr = null;
  }
}

/**
 * Merge row arrays from several shards. `gaugeMode` maps field index -> 'sum' | 'max'
 * (counters are summed; gauges such as configured limits use max).
 */
export function mergeRows(rowSets, F, gaugeMode = {}) {
  const m = new Map();
  for (const rows of rowSets) {
    for (const r of rows) {
      let a = m.get(r[0]);
      if (!a) { a = new Array(F + 1).fill(0); a[0] = r[0]; m.set(r[0], a); }
      for (let i = 1; i <= F; i++) {
        if (gaugeMode[i - 1] === 'max') a[i] = Math.max(a[i], r[i]);
        else a[i] += r[i];
      }
    }
  }
  return [...m.values()].sort((x, y) => x[0] - y[0]);
}
