#!/usr/bin/env node
/**
 * Starts provider simulator + gateway (+ a callback receiver) for manual exploration
 * and demos, and keeps them running until Ctrl+C.
 *
 *   node scenarios/stack.js [--config config/provider.default.json] [--shards 1] [--provider-shards 1]
 *
 * Dashboard: http://127.0.0.1:8000/   Provider control: http://127.0.0.1:9000/v1/models
 * Callback receiver (rejects first 2 attempts): http://127.0.0.1:9900/callback  (GET /received)
 */
import path from 'node:path';
import { parseArgs, num } from '../src/common/util.js';
import { startStack, ROOT } from './lib.js';
import { startCallbackSink } from './callback-sink.js';

const a = parseArgs();
const stack = await startStack({
  providerConfig: a.config || 'config/provider.default.json',
  providerShards: num(a.providerShards, 1),
  gatewayShards: num(a.shards, 1),
  logDir: path.join(ROOT, 'reports', 'stack-logs'),
});
await startCallbackSink({ port: num(a.sinkPort, 9900), failFirst: num(a.failFirst, 2), gatewayUrl: stack.gatewayUrl });
console.log(`gateway    ${stack.gatewayUrl}   (dashboard: ${stack.gatewayUrl}/)
provider   ${stack.providerUrl}   (GET /v1/models, PATCH /v1/models/:name)
callbacks  http://127.0.0.1:${num(a.sinkPort, 9900)}/callback   (GET /received)
logs       reports/stack-logs/
Ctrl+C to stop.`);
setInterval(() => {}, 1 << 30);
