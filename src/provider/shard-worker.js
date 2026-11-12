import { parentPort, workerData } from 'node:worker_threads';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { ProviderSim } from './sim.js';
import {
  FrameReader, T_CALLS, decodeCalls, encodeResults,
} from '../common/proto.js';

/** One provider shard: a TCP endpoint in front of a ProviderSim instance. */
const { host, port, shardIndex, shardCount, models, seed } = workerData;

const conns = new Map();
let nextConn = 1;

const sim = new ProviderSim({
  models,
  shardIndex,
  shardCount,
  seed,
  onResults(sinkId, flat, n) {
    const sock = conns.get(sinkId);
    if (sock && !sock.destroyed) sock.write(encodeResults(flat, n));
  },
});

const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  const id = nextConn++;
  conns.set(id, sock);
  const scratch = { ids: new Uint32Array(1024), toks: new Uint32Array(1024) };
  const reader = new FrameReader((buf, s) => {
    if (buf[s] !== T_CALLS) return;
    const { name, n, payloadBytes } = decodeCalls(buf, s, scratch);
    sim.submit(id, name, n, scratch.ids, scratch.toks, Date.now(), performance.now(), payloadBytes);
  });
  sock.on('data', (c) => reader.push(c));
  sock.on('close', () => { conns.delete(id); sim.dropSink(id); });
  sock.on('error', () => {});
});

server.listen(port, host, () => parentPort.postMessage({ type: 'ready', shardIndex, port }));

// Results are released on a ~1 ms loop (OS timer resolution permitting).
function loop() {
  sim.tick(performance.now());
  setTimeout(loop, 1);
}
loop();

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'upsert_model':
      sim.upsertModel(msg.model);
      break;
    case 'metrics':
      parentPort.postMessage({ type: 'reply', id: msg.id, data: sim.metrics(msg.sinceMs || 0) });
      break;
    case 'reset_metrics':
      sim.resetMetrics();
      parentPort.postMessage({ type: 'reply', id: msg.id, data: { ok: true } });
      break;
    default:
  }
});
