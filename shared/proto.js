/**
 * Binary wire protocol between gateway engine shards and provider simulator shards.
 *
 * JSON-over-HTTP per call costs far more CPU than the simulated work at 300k+ calls/s,
 * so dispatchers pipeline many calls per frame over one persistent TCP connection.
 * Every call still has its own id, its own simulated latency and outcome, and its own
 * result record; frames are only a transport optimisation (like HTTP/2 multiplexing).
 *
 * Frame:   u32 length (bytes after this field) | u8 type | body
 * CALLS:   u16 nameLen | model name (utf8) | u32 count | count x (u32 callId | u32 tokens | u32 payloadLen | payload)
 * RESULTS: u32 count | count x (u32 callId | u8 status | u32 latencyMicros | u32 outputTokens)
 */
export const T_CALLS = 1;
export const T_RESULTS = 2;

export const S_OK = 0;
export const S_RATE_LIMITED = 1; // provider-side 429: over its RPM/TPM limit
export const S_TRANSIENT = 2; // 5xx / overloaded: retryable
export const S_PERMANENT = 3; // 4xx: bad request / content rejected: not retryable
export const S_TIMEOUT = 4; // provider did not answer in time: retryable
export const STATUS_NAMES = ['ok', 'rate_limited', 'transient_error', 'permanent_error', 'timeout'];

const RESULT_REC = 13;

export function encodeCalls(nameBuf, n, ids, toks, pays) {
  let size = 4 + 1 + 2 + nameBuf.length + 4 + n * 12;
  for (let i = 0; i < n; i++) {
    const p = pays[i];
    if (p) size += Buffer.byteLength(p, 'utf8');
  }
  const buf = Buffer.allocUnsafe(size);
  buf.writeUInt32LE(size - 4, 0);
  buf[4] = T_CALLS;
  buf.writeUInt16LE(nameBuf.length, 5);
  nameBuf.copy(buf, 7);
  let o = 7 + nameBuf.length;
  buf.writeUInt32LE(n, o); o += 4;
  for (let i = 0; i < n; i++) {
    buf.writeUInt32LE(ids[i] >>> 0, o);
    buf.writeUInt32LE(toks[i] >>> 0, o + 4);
    const p = pays[i];
    if (p) {
      const w = buf.write(p, o + 12, 'utf8');
      buf.writeUInt32LE(w, o + 8);
      o += 12 + w;
    } else {
      buf.writeUInt32LE(0, o + 8);
      o += 12;
    }
  }
  return buf;
}

/**
 * Decode a CALLS frame body (buf[start] is the type byte). Fills the provided
 * growable scratch object { ids: Uint32Array, toks: Uint32Array } and returns
 * { name, n, payloadBytes }.
 */
export function decodeCalls(buf, start, scratch) {
  let o = start + 1;
  const nl = buf.readUInt16LE(o); o += 2;
  const name = buf.toString('utf8', o, o + nl); o += nl;
  const n = buf.readUInt32LE(o); o += 4;
  if (scratch.ids.length < n) {
    let cap = scratch.ids.length || 1024;
    while (cap < n) cap *= 2;
    scratch.ids = new Uint32Array(cap);
    scratch.toks = new Uint32Array(cap);
  }
  const { ids, toks } = scratch;
  let payloadBytes = 0;
  for (let i = 0; i < n; i++) {
    ids[i] = buf.readUInt32LE(o);
    toks[i] = buf.readUInt32LE(o + 4);
    const pl = buf.readUInt32LE(o + 8);
    payloadBytes += pl;
    o += 12 + pl;
  }
  return { name, n, payloadBytes };
}

/** flat: [callId, status, latencyMicros, outputTokens] * n */
export function encodeResults(flat, n) {
  const size = 4 + 1 + 4 + n * RESULT_REC;
  const buf = Buffer.allocUnsafe(size);
  buf.writeUInt32LE(size - 4, 0);
  buf[4] = T_RESULTS;
  buf.writeUInt32LE(n, 5);
  let o = 9;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    buf.writeUInt32LE(flat[j] >>> 0, o);
    buf[o + 4] = flat[j + 1];
    buf.writeUInt32LE(Math.min(flat[j + 2], 0xffffffff) >>> 0, o + 5);
    buf.writeUInt32LE(flat[j + 3] >>> 0, o + 9);
    o += RESULT_REC;
  }
  return buf;
}

export function decodeResults(buf, start, onResult) {
  let o = start + 1;
  const n = buf.readUInt32LE(o); o += 4;
  for (let i = 0; i < n; i++) {
    onResult(buf.readUInt32LE(o), buf[o + 4], buf.readUInt32LE(o + 5), buf.readUInt32LE(o + 9));
    o += RESULT_REC;
  }
  return n;
}

/** Reassembles length-prefixed frames from a TCP byte stream. */
export class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame; // (buf, bodyStart, bodyEnd)
    this.pending = null;
    this.parts = [];
    this.have = 0;
    this.need = 0;
  }

  push(chunk) {
    if (this.need > 0) {
      this.parts.push(chunk);
      this.have += chunk.length;
      if (this.have < this.need) return;
      chunk = Buffer.concat(this.parts, this.have);
      this.parts = [];
      this.have = 0;
      this.need = 0;
    } else if (this.pending) {
      chunk = Buffer.concat([this.pending, chunk]);
      this.pending = null;
    }
    const L = chunk.length;
    let o = 0;
    while (L - o >= 4) {
      const len = chunk.readUInt32LE(o);
      if (L - o - 4 < len) {
        this.parts = [chunk.subarray(o)];
        this.have = L - o;
        this.need = len + 4;
        return;
      }
      this.onFrame(chunk, o + 4, o + 4 + len);
      o += 4 + len;
    }
    if (o < L) this.pending = chunk.subarray(o);
  }
}
