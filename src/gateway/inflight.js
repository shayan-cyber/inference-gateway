/**
 * In-flight call table: callId -> (batch, index, sentAt), with no allocation per call.
 *
 * Call ids are handed out by the table and chosen so that `id & mask` lands on a free
 * slot of a power-of-two ring of typed arrays. Lookup is then one array read plus an id
 * check. The ring is kept at most half full (it doubles when needed). Any entry that
 * collides while the ring is being resized goes to a small overflow Map, so lookups stay
 * exact. This replaced a Map of small objects, which profiling showed at ~10% CPU plus
 * GC pressure.
 */
export class InflightTable {
  constructor(cap = 1 << 16) {
    this._alloc(cap);
    this.size = 0;
    this.next = 0;
    this.overflow = new Map(); // id -> [b, i, t]
  }

  _alloc(cap) {
    this.cap = cap;
    this.mask = cap - 1;
    this.ids = new Uint32Array(cap); // 0 = empty
    this.bs = new Array(cap);
    this.is = new Int32Array(cap);
    this.ts = new Float64Array(cap);
  }

  _grow() {
    const { ids, bs, is, ts, cap } = this;
    this._alloc(cap * 2);
    for (let s = 0; s < cap; s++) {
      const id = ids[s];
      if (id === 0) continue;
      const ns = id & this.mask;
      if (this.ids[ns] === 0) {
        this.ids[ns] = id; this.bs[ns] = bs[s]; this.is[ns] = is[s]; this.ts[ns] = ts[s];
      } else this.overflow.set(id, [bs[s], is[s], ts[s]]);
    }
  }

  /** Registers a call and returns its id (never 0). */
  add(b, i, t) {
    if ((this.size + 1) * 2 > this.cap) this._grow();
    let id; let s;
    do {
      id = (this.next + 1) >>> 0;
      if (id === 0) id = 1;
      this.next = id;
      s = id & this.mask;
    } while (this.ids[s] !== 0 || (this.overflow.size > 0 && this.overflow.has(id)));
    this.ids[s] = id; this.bs[s] = b; this.is[s] = i; this.ts[s] = t;
    this.size++;
    return id;
  }

  /**
   * Removes `id` and calls fn(b, i, sentAt). Returns false if `id` is unknown
   * (already answered, timed out or retried).
   */
  take(id, fn) {
    const s = id & this.mask;
    if (this.ids[s] === id) {
      const b = this.bs[s]; const i = this.is[s]; const t = this.ts[s];
      this.ids[s] = 0; this.bs[s] = undefined; this.size--;
      fn(b, i, t);
      return true;
    }
    if (this.overflow.size > 0) {
      const e = this.overflow.get(id);
      if (e) { this.overflow.delete(id); this.size--; fn(e[0], e[1], e[2]); return true; }
    }
    return false;
  }

  /** Removes every entry for which pred(b, i, t) is true and passes it to fn. */
  removeWhere(pred, fn) {
    if (this.size === 0) return;
    const out = [];
    for (let s = 0; s < this.cap; s++) {
      if (this.ids[s] === 0 || !pred(this.bs[s], this.is[s], this.ts[s])) continue;
      out.push(this.bs[s], this.is[s], this.ts[s]);
      this.ids[s] = 0; this.bs[s] = undefined; this.size--;
    }
    for (const [id, e] of this.overflow) {
      if (!pred(e[0], e[1], e[2])) continue;
      out.push(e[0], e[1], e[2]);
      this.overflow.delete(id); this.size--;
    }
    for (let k = 0; k < out.length; k += 3) fn(out[k], out[k + 1], out[k + 2]);
  }
}
