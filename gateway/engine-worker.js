import { parentPort, workerData } from 'node:worker_threads';
import { Engine, HttpError, REJECTED } from './engine.js';
import { TcpProviderClient } from './provider-client.js';

/** Hosts one Engine shard on its own thread; the main thread talks to it by message. */
const {
  shardId, shardCount, provider: pcfg, models, options,
} = workerData;

const provider = new TcpProviderClient({ host: pcfg.host, port: pcfg.port });
const engine = new Engine({
  shardId,
  shardCount,
  models,
  provider,
  options,
  onEvent: (ev) => parentPort.postMessage({ type: 'event', shardId, ...ev }),
});
engine.start();

const base = options.publicBaseUrl || '';

function reply(id, status, body, headers) {
  parentPort.postMessage({
    type: 'reply', id, status, body: typeof body === 'string' ? body : JSON.stringify(body), headers,
  });
}

function notFound(id, what) {
  reply(id, 404, { error: 'not_found', message: `${what} not found (unknown id, or evicted after the retention period)` });
}

function handle(msg) {
  switch (msg.type) {
    case 'submit': {
      let body;
      try {
        body = JSON.parse(Buffer.from(msg.body.buffer, msg.body.byteOffset, msg.body.byteLength).toString('utf8'));
      } catch {
        throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
      }
      const b = engine.submit(body, msg.kind, Date.now());
      if (msg.kind === 'single') {
        if (msg.wait) {
          if (b.remaining === 0) return reply(msg.id, 200, engine.requestView(b));
          let done = false;
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reply(msg.id, 202, engine.requestView(b));
          }, msg.waitMs || 30_000);
          (b.waiters ||= []).push(() => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reply(msg.id, 200, engine.requestView(b));
          });
          return undefined;
        }
        return reply(msg.id, 202, {
          id: b.id,
          request_id: engine.requestIdAt(b, 0),
          status: 'queued',
          status_url: `${base}/v1/requests/${b.id}`,
        });
      }
      return reply(msg.id, 202, {
        batch_id: b.id,
        status: b.counts[REJECTED] ? 'partially_accepted' : 'accepted',
        total: b.n,
        accepted: b.n - b.counts[REJECTED],
        rejected: b.counts[REJECTED],
        rejected_by_model: b.rejectedByModel || undefined,
        accepted_at: new Date(b.createdAt).toISOString(),
        status_url: `${base}/v1/batches/${b.id}`,
        results_url: `${base}/v1/batches/${b.id}/results`,
        callback_url: b.callbackUrl,
      });
    }
    case 'get_batch': {
      const b = engine.batches.get(msg.batchId);
      if (!b || b.kind !== 'batch') return notFound(msg.id, 'batch');
      return reply(msg.id, 200, engine.batchView(b));
    }
    case 'get_results': {
      const b = engine.batches.get(msg.batchId);
      if (!b || b.kind !== 'batch') return notFound(msg.id, 'batch');
      const offset = Math.max(0, msg.offset | 0);
      const limit = Math.min(50_000, Math.max(1, msg.limit || 10_000));
      return reply(msg.id, 200, engine.results(b, offset, limit));
    }
    case 'get_request': {
      const b = engine.batches.get(msg.requestId);
      if (!b || b.kind !== 'single') return notFound(msg.id, 'request');
      return reply(msg.id, 200, engine.requestView(b));
    }
    case 'upsert_model':
      engine.upsertModel(msg.model);
      return undefined;
    case 'stats':
      return parentPort.postMessage({ type: 'data', id: msg.id, data: engine.exportStats(msg.sinceMs || 0, !!msg.series) });
    default:
      return undefined;
  }
}

parentPort.on('message', (msg) => {
  try {
    handle(msg);
  } catch (e) {
    if (e instanceof HttpError) {
      const headers = e.status === 429 ? { 'retry-after': String(e.extra.retry_after_s || 1) } : undefined;
      reply(msg.id, e.status, { error: e.code, message: e.message, ...e.extra }, headers);
    } else {
      console.error(`[gateway shard ${shardId}]`, e);
      reply(msg.id, 500, { error: 'internal_error', message: e.message });
    }
  }
});
