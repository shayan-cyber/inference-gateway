import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindow, ModelLimiter } from '../shared/limiter.js';
import { makeRng } from '../shared/rng.js';

test('sliding window ages out buckets after 60s', () => {
  const w = new SlidingWindow(60_000, 100);
  w.add(0, 10);
  w.add(30_000, 5);
  assert.equal(w.sum(30_000), 15);
  assert.equal(w.sum(60_050), 15); // bucket 0 is still inside the conservative 60.1 s span
  assert.equal(w.sum(60_100), 5);
  assert.equal(w.sum(90_100), 0);
  assert.equal(w.sum(500_000), 0);
});

/**
 * Property: whatever the arrival pattern and limit changes, no 60 s window
 * (at any alignment, checked at 1 ms resolution) contains more admissions than
 * the limit in force at the time of the last admission in that window.
 */
test('limiter never admits more than the limit in any 60s window (randomised)', () => {
  const rng = makeRng(99);
  for (let trial = 0; trial < 4; trial++) {
    let rpm = 600 + Math.floor(rng.next() * 3000);
    const lim = new ModelLimiter({ rpm, tpm: 1e12, pacing: trial % 2 === 0 });
    const admits = []; // [t, limitAtAdmission]
    for (let t = 0; t < 240_000; t += 1 + Math.floor(rng.next() * 20)) {
      if (rng.next() < 0.0005) { rpm = 200 + Math.floor(rng.next() * 4000); lim.setLimits(rpm, 1e12); }
      const tries = 1 + Math.floor(rng.next() * 5);
      for (let k = 0; k < tries; k++) if (lim.tryAcquire(1, t)) admits.push([t, rpm]);
    }
    // two-pointer over admissions: window (t-60000, t]
    let lo = 0;
    for (let hi = 0; hi < admits.length; hi++) {
      while (admits[lo][0] <= admits[hi][0] - 60_000) lo++;
      const count = hi - lo + 1;
      assert.ok(count <= admits[hi][1], `trial ${trial}: ${count} admissions in 60s window ending ${admits[hi][0]} > limit ${admits[hi][1]}`);
    }
    assert.ok(admits.length > 0);
  }
});

test('pacing spreads admissions instead of bursting the whole minute', () => {
  const lim = new ModelLimiter({ rpm: 60_000, tpm: 1e12, utilization: 1, burstMs: 100 });
  let first = 0;
  for (let i = 0; i < 100_000; i++) if (lim.tryAcquire(1, 0)) first++;
  assert.ok(first <= 101, `burst at t=0 was ${first}`);
  let total = first;
  for (let t = 1; t <= 10_000; t++) while (lim.tryAcquire(1, t)) total++;
  assert.ok(total > 9_800 && total <= 10_101, `10 s at 1000/s admitted ${total}`);
});

test('token limit binds independently of request limit', () => {
  const lim = new ModelLimiter({ rpm: 1e9, tpm: 10_000, pacing: false });
  let n = 0;
  while (lim.tryAcquire(1000, 0)) n++;
  assert.equal(n, 10);
});

test('lowering the limit blocks until the trailing window drains below it', () => {
  const lim = new ModelLimiter({ rpm: 1000, tpm: 1e12, pacing: false });
  for (let i = 0; i < 1000; i++) assert.ok(lim.tryAcquire(1, 0));
  lim.setLimits(100, 1e12);
  assert.equal(lim.tryAcquire(1, 30_000), false);
  assert.equal(lim.tryAcquire(1, 60_050), false);
  assert.equal(lim.tryAcquire(1, 60_100), true);
});
