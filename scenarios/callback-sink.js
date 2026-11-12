#!/usr/bin/env node
/**
 * Test receiver for batch-completion callbacks.
 *
 *   node scenarios/callback-sink.js [--port 9900] [--fail-first 2] [--gateway http://127.0.0.1:8000]
 *
 * Rejects the first N delivery attempts with HTTP 503 (a destination that is down),
 * then accepts with 200. For every attempt it records arrival time and headers, and
 * (if --gateway is given) queries the batch status at that moment, to show the
 * callback only fires after every request is final.
 * GET /received lists everything received.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseArgs, num, fetchJson } from '../src/common/util.js';

export function startCallbackSink({ port = 9900, failFirst = 2, gatewayUrl = null, quiet = false } = {}) {
  const attempts = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/received') {
      const body = JSON.stringify(attempts.map((a) => ({ ...a, body: a.body ? { ...a.body, results: a.body.results ? `[${a.body.results.length} results]` : null } : null })), null, 2);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(body);
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const receivedAt = Date.now();
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* keep null */ }
      const n = attempts.length + 1;
      const reject = n <= failFirst;
      const rec = {
        n,
        receivedAt,
        attemptHeader: req.headers['x-callback-attempt'],
        idempotencyKey: req.headers['idempotency-key'],
        batchId: body?.batch_id,
        responded: reject ? 503 : 200,
        statusAtArrival: null,
        body,
      };
      attempts.push(rec);
      if (gatewayUrl && body?.batch_id) {
        try { rec.statusAtArrival = await fetchJson(`${gatewayUrl}/v1/batches/${body.batch_id}`); } catch (e) { rec.statusAtArrival = { error: e.message }; }
      }
      if (!quiet) console.log(`[callback-sink] attempt ${n} for ${body?.batch_id} (header attempt=${rec.attemptHeader}) -> ${rec.responded}${body ? ` status=${body.status} total=${body.total} ok=${body.succeeded} failed=${body.failed}` : ''}`);
      res.writeHead(rec.responded, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: !reject }));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${port}/callback`,
      attempts,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = parseArgs();
  const sink = await startCallbackSink({ port: num(a.port, 9900), failFirst: num(a.failFirst, 2), gatewayUrl: a.gateway || null });
  console.log(`[callback-sink] listening at ${sink.url} (rejecting the first ${num(a.failFirst, 2)} attempts)`);
}
