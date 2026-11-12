import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from '../shared/util.js';

export { waitForDrain, logProgress } from '../tools/loadgen/progress.js';
export { summarizeRun, summaryMarkdown, envMarkdown } from '../tools/report/summary.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const children = new Set();
function killAll() { for (const c of children) { try { c.kill(); } catch { /* ignore */ } } }
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(); process.exit(130); });

function startProc(name, args, logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(path.join(logDir, `${name}.log`), 'w');
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', fd, fd] });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

async function waitHealthy(url, what, child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`${what} exited early (code ${child.exitCode}); see its log`);
    try { return await fetchJson(url, { timeoutMs: 1000 }); } catch { await sleep(100); }
  }
  throw new Error(`${what} did not become healthy at ${url}`);
}

/** Starts provider simulator + gateway as separate OS processes. */
export async function startStack({
  providerConfig, providerShards = 1, gatewayShards = 1, gatewayArgs = [], providerPort = 9000,
  shardBasePort = 9100, gatewayPort = 8000, logDir, seed = 42,
}) {
  const providerUrl = `http://127.0.0.1:${providerPort}`;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  // Refuse to run against processes we did not start (e.g. a demo stack left running):
  // the health checks below would otherwise succeed against them and measure the wrong thing.
  for (const [url, what] of [[`${providerUrl}/health`, 'provider'], [`${gatewayUrl}/healthz`, 'gateway']]) {
    let busy = false;
    try { await fetchJson(url, { timeoutMs: 500 }); busy = true; } catch { /* free */ }
    if (busy) throw new Error(`a ${what} is already running at ${url}; stop it first (e.g. a leftover \`npm run stack\`)`);
  }
  const prov = startProc('provider', ['tools/provider-sim/server.js', '--config', providerConfig, '--port', String(providerPort),
    '--shards', String(providerShards), '--shard-base-port', String(shardBasePort), '--seed', String(seed)], logDir);
  await waitHealthy(`${providerUrl}/health`, 'provider', prov);
  const gw = startProc('gateway', ['gateway/server.js', '--port', String(gatewayPort), '--provider', providerUrl,
    '--shards', String(gatewayShards), '--config', 'config/gateway.default.json', ...gatewayArgs], logDir);
  const health = await waitHealthy(`${gatewayUrl}/healthz`, 'gateway', gw);
  return {
    providerUrl,
    gatewayUrl,
    gatewayPid: health.pid,
    async stop() {
      for (const c of [gw, prov]) { try { c.kill(); } catch { /* ignore */ } }
      await sleep(300);
    },
  };
}

export function pass(ok) { return ok ? 'PASS' : 'FAIL'; }

export function reportDir(name) {
  return path.join(ROOT, 'reports', name);
}
