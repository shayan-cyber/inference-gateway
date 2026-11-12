/**
 * Small, fast, seedable PRNG (mulberry32) plus a Gaussian sampler.
 * Seeded so simulator outcomes are repeatable run to run.
 */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = 0;
  let hasSpare = false;
  const normal = () => {
    if (hasSpare) { hasSpare = false; return spare; }
    let u; let v; let s;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m; hasSpare = true;
    return u * m;
  };
  return { next, normal };
}
