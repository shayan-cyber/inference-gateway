/** Growable ring-buffer deque of (object, int) pairs. O(1) push/unshift/shift. */
export class Deque {
  constructor(cap = 1024) {
    this.cap = cap;
    this.mask = cap - 1;
    this.objs = new Array(cap);
    this.nums = new Int32Array(cap);
    this.head = 0;
    this.length = 0;
  }

  _grow() {
    const nc = this.cap * 2;
    const no = new Array(nc);
    const nn = new Int32Array(nc);
    for (let k = 0; k < this.length; k++) {
      const j = (this.head + k) & this.mask;
      no[k] = this.objs[j];
      nn[k] = this.nums[j];
    }
    this.objs = no; this.nums = nn; this.cap = nc; this.mask = nc - 1; this.head = 0;
  }

  push(o, x = 0) {
    if (this.length === this.cap) this._grow();
    const j = (this.head + this.length) & this.mask;
    this.objs[j] = o;
    this.nums[j] = x;
    this.length++;
  }

  unshift(o, x = 0) {
    if (this.length === this.cap) this._grow();
    this.head = (this.head - 1) & this.mask;
    this.objs[this.head] = o;
    this.nums[this.head] = x;
    this.length++;
  }

  peekObj() { return this.objs[this.head]; }

  peekNum() { return this.nums[this.head]; }

  shift() {
    this.objs[this.head] = undefined;
    this.head = (this.head + 1) & this.mask;
    this.length--;
  }
}
