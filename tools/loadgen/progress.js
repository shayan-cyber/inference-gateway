/** Console progress and gateway drain helpers shared by the load generator CLI and the scenarios. */
import { fetchJson, sleep, fmtInt } from '../../shared/util.js';

/** Polls gateway stats until nothing is waiting and no callback is pending. */
export async function waitForDrain(gatewayUrl, timeoutMs = 180_000, log = true) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeoutMs) {
    s = await fetchJson(`${gatewayUrl}/v1/stats`);
    if (s.totals.waiting === 0 && s.totals.callbacksPending === 0) return { drained: true, stats: s, ms: Date.now() - t0 };
    if (log) process.stdout.write(`\r  draining: waiting=${fmtInt(s.totals.waiting)} callbacks_pending=${s.totals.callbacksPending}      `);
    await sleep(1000);
  }
  return { drained: false, stats: s, ms: Date.now() - t0 };
}

export function logProgress(prefix, t0) {
  return (st) => {
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\r  ${prefix} t=${el}s submitted=${fmtInt(st.submitted)} accepted=${fmtInt(st.accepted)} rejected=${fmtInt(st.rejected)} open=${st.open ?? ''}      `);
  };
}
