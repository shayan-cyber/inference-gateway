import net from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  FrameReader, T_RESULTS, encodeCalls, decodeResults,
} from '../common/proto.js';

function outBuf(m) {
  if (!m._out) m._out = { ids: [], toks: [], pays: [], n: 0, nameBuf: Buffer.from(m.name) };
  return m._out;
}

/**
 * Pipelined binary-protocol client to one provider shard. Calls enqueued during a
 * dispatch tick are written as one CALLS frame per model on flush(). `ready` goes
 * false while disconnected or while the socket buffer is full (TCP backpressure);
 * the engine stops dispatching (and stops consuming rate-limit budget) until it
 * returns.
 */
export class TcpProviderClient {
  constructor({ host, port }) {
    this.host = host;
    this.port = port;
    this.ready = false;
    this.connected = false;
    this.closed = false;
    this.reconnectDelay = 100;
    this.dirty = [];
    this.engine = null;
    this.framesOut = 0;
    this.bytesOut = 0;
  }

  attach(engine) {
    this.engine = engine;
    this._onResult = (id, st, lat, out) => engine.onResult(id, st, lat, out);
    this.connect();
  }

  connect() {
    const sock = net.connect({ host: this.host, port: this.port });
    sock.setNoDelay(true);
    this.sock = sock;
    const reader = new FrameReader((buf, s) => {
      if (buf[s] === T_RESULTS) decodeResults(buf, s, this._onResult);
    });
    sock.on('connect', () => {
      this.connected = true;
      this.ready = true;
      this.reconnectDelay = 100;
    });
    sock.on('data', (c) => reader.push(c));
    sock.on('drain', () => { if (this.connected) this.ready = true; });
    sock.on('error', () => {});
    sock.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this.ready = false;
      this.sock = null;
      if (was && this.engine) this.engine.onProviderDisconnect();
      if (!this.closed) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(5000, this.reconnectDelay * 2);
      }
    });
  }

  enqueue(m, callId, tokens, payload) {
    const o = outBuf(m);
    if (o.n === 0) this.dirty.push(m);
    o.ids.push(callId);
    o.toks.push(tokens);
    o.pays.push(payload);
    o.n++;
  }

  flush() {
    if (this.dirty.length === 0) return;
    for (const m of this.dirty) {
      const o = m._out;
      if (this.sock && this.connected) {
        const frame = encodeCalls(o.nameBuf, o.n, o.ids, o.toks, o.pays);
        this.framesOut++;
        this.bytesOut += frame.length;
        if (!this.sock.write(frame)) this.ready = false;
      }
      // If the socket dropped mid-tick the calls are already in the engine's in-flight
      // table; onProviderDisconnect() will retry them.
      o.ids.length = 0; o.toks.length = 0; o.pays.length = 0; o.n = 0;
    }
    this.dirty.length = 0;
  }

  close() {
    this.closed = true;
    if (this.sock) this.sock.destroy();
  }
}

/**
 * Same interface, but calls a ProviderSim living in the same thread. Used by the
 * in-process engine benchmark and tests (no sockets, no serialisation).
 */
export class InProcProvider {
  constructor(sim) {
    this.sim = sim;
    this.ready = true;
    this.dirty = [];
    this.engine = null;
  }

  attach(engine) {
    this.engine = engine;
    this.sim.onResults = (sinkId, flat, n) => {
      for (let j = 0; j < n * 4; j += 4) engine.onResult(flat[j], flat[j + 1], flat[j + 2], flat[j + 3]);
    };
  }

  enqueue(m, callId, tokens, payload) {
    const o = outBuf(m);
    if (o.n === 0) this.dirty.push(m);
    o.ids.push(callId);
    o.toks.push(tokens);
    o.pays.push(payload);
    o.n++;
  }

  flush() {
    if (this.dirty.length === 0) return;
    const wall = Date.now();
    const mono = performance.now();
    for (const m of this.dirty) {
      const o = m._out;
      let bytes = 0;
      for (let i = 0; i < o.n; i++) if (o.pays[i]) bytes += o.pays[i].length;
      this.sim.submit(1, m.name, o.n, o.ids, o.toks, wall, mono, bytes);
      o.ids.length = 0; o.toks.length = 0; o.pays.length = 0; o.n = 0;
    }
    this.dirty.length = 0;
  }

  poll() {
    this.sim.tick(performance.now());
  }

  close() {}
}
