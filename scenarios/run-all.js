#!/usr/bin/env node
/**
 * Regenerates every piece of evidence in reports/: the three validation scenarios and
 * the throughput benchmarks, one after another (~20 minutes). Exits non-zero if any
 * scenario fails.
 *
 *   node scenarios/run-all.js [--skip-bench]
 */
import { spawnSync } from 'node:child_process';
import { parseArgs, bool } from '../shared/util.js';
import { ROOT } from './lib.js';

const a = parseArgs();
const runs = [
  ['scenarios/scenario3.js'],
  ['scenarios/scenario1.js'],
  ['scenarios/scenario2.js'],
];
if (!bool(a.skipBench, false)) {
  runs.push(
    ['scenarios/bench.js', '--mode', 'e2e', '--rate', '300000', '--duration', '30', '--gateway-shards', '4', '--provider-shards', '4', '--loadgen-workers', '4'],
    ['scenarios/bench.js', '--mode', 'e2e', '--rate', '1000000', '--duration', '30', '--gateway-shards', '8', '--provider-shards', '4', '--loadgen-workers', '4'],
    ['scenarios/bench.js', '--mode', 'engine', '--rate', '1000000', '--duration', '15', '--shards', '14'],
  );
}
let failed = 0;
for (const args of runs) {
  console.log(`\n=== node ${args.join(' ')}`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(`\n${failed ? `${failed} run(s) FAILED` : 'all runs passed'}; reports in reports/`);
process.exitCode = failed ? 1 : 0;
