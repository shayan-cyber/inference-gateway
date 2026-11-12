# Benchmark report

Everything in **Measured** comes from runs whose raw reports (Markdown, JSON, SVG charts)
are committed under [`reports/`](reports/) and can be regenerated with `npm run evidence`
(~20 min). **Projections** are labelled as such and kept separate.

## Test environment

| | |
| --- | --- |
| Machine | Laptop, 12th Gen Intel Core i5-12500H (4 performance + 8 efficiency cores, 16 threads), 15.6 GB RAM |
| OS | Windows 11 (10.0.26200) |
| Runtime | Node.js v24.15.0, no dependencies |
| Topology | All processes on the same machine over loopback: load generator, gateway, provider simulator. They share the 16 hardware threads. |
| Timers | Windows timer resolution (~1–15 ms) bounds how often the dispatch loop and the simulator's timing wheel wake up. This adds a few ms of latency; it does not limit throughput, because each wake-up handles everything that is due. |

### Simulation assumptions

* The provider is the simulator in `tools/provider-sim/`. Per call it enforces RPM/TPM
  (strict trailing 60 s; 429 when exceeded), draws an outcome (transient error, timeout,
  permanent error or success), and draws a latency (lognormal from median and p99),
  all from a seeded RNG.
* A request is **completed** only when its simulated provider call reached a final
  success or failure **and** the gateway recorded that final state. Accepting it at the
  API doesn't count.
* TPM is charged on `estimated_tokens` when the call is sent.
* For the throughput benchmarks the limits are raised to 60B RPM so they don't bind
  (allowed by the assignment). The validation scenarios use the limits as specified.

---

## Measured: validation scenarios

| Scenario | Result | Headline numbers | Report |
| --- | --- | --- | --- |
| 1: reach provider capacity (50,000 RPM / 100M TPM, 1,000-token requests at 120% of capacity for 5 min) | **PASS** | **97.5%** of allowed capacity completed after warm-up (812.7 of 833.3 req/s). Max trailing-60 s requests at the provider **49,218 / 50,000**; tokens 49.2M / 100M; **0** windows over the limit; **0** provider 429s. 299,900 submitted = 268,400 completed + 31,500 rejected (429) + 0 expired + 0 waiting. | [reports/scenario1](reports/scenario1/report.md) |
| 2: two models, model-a cut to 5,000 RPM and restored | **PASS** | 0 windows over the limit in force, for both models. The gateway applied the cut **452 ms** after the provider changed it and the restore **303 ms** after, with the same gateway PID throughout. model-a ran at **4,900 RPM** once its window drained and **29,399 RPM** after the restore. model-b held **19,600 RPM before, during and after**. | [reports/scenario2](reports/scenario2/report.md) |
| 3: one 10,000-request batch, failures injected, callback rejected twice | **PASS** | Ack in **30.7 ms** (1.1 MB body). Batch finished in 24.7 s; callback attempts at +0.05 s (503), +1.0 s (503), +3.15 s (**200**). The callback summary was identical to `GET /v1/batches/:id`. Every one of the 10,000 request ids appeared exactly once, in both the results API and the inline callback results. | [reports/scenario3](reports/scenario3/report.md) |

### Scenario 1: details

| | p50 | p95 | p99 |
| --- | --- | --- | --- |
| Provider round trip (ms) | 307 | 1,163 | 2,015 |
| End-to-end, accepted → final (ms) | 30,147 | 31,195 | 31,719 |
| API acknowledgement (ms) | 1.1 | 2.1 | 3.5 |

End-to-end latency here is **by design**. The test offers 120% of capacity for five
minutes, so the backlog grows until the admission bound (30 s estimated wait) is hit.
After that the gateway sheds the excess with 429s (31,500 requests) instead of letting
the queue grow forever. Accepted requests therefore wait about 30 s. The provider round
trip (307 ms p50) is what the simulated model itself costs. Steady state is 98.4% of
the limit in every 60 s window: pacing targets 98%, and the strict window guard never
had to step in.

### Scenario 2: limits and throughput over time (provider-side counts, from the report)

| t (s) | model-a limit | model-a observed RPM | model-a trailing 60 s | model-b observed RPM |
| --- | --- | --- | --- | --- |
| 61 | 30,000 | 29,388 | 29,452 | 19,590 |
| 121 | **5,000** | 0 | 28,323 | 19,578 |
| 151 | 5,000 | 0 | 13,625 | 19,590 |
| 171 | 5,000 | 4,902 | 4,022 | 19,608 |
| 221 | 5,000 | 4,902 | 4,281 | 19,596 |
| 241 | **30,000** | 29,376 | 5,722 | 19,584 |
| 301 | 30,000 | 29,370 | 29,444 | 19,584 |

After the cut, model-a sends nothing until its trailing minute ages below 5,000 (about
50 s), then runs at ~98% of 5,000 RPM. That is the strict semantics described in
[docs/DESIGN.md §3](docs/DESIGN.md). 9,133 model-a requests queued before the cut **expired**
(TTL 120 s) rather than being sent late; 122,536 were refused at admission over the run.
Every request is accounted for: 395,900 = 264,231 completed + 9,133 expired + 122,536 rejected.

The first run of this scenario **failed**. Admission control refused whole mixed
batches once model-a backed up, which starved model-b (19.6k → 6.8k RPM). The fix was
per-model admission inside a batch. The report above is from after the fix, and there
is a unit test for it.

---

## Measured: throughput benchmarks

| Benchmark | What runs | Target | **Steady completions/s** (mean; median; worst 1 s) | Requests | e2e latency p50 / p95 / p99 | Report |
| --- | --- | --- | --- | --- | --- | --- |
| **Required: 300k/s, full system** | loadgen (4 threads) → HTTP/JSON → gateway (main + 4 engine shards) → binary TCP → provider sim (4 shards); 3 OS processes | 300,000/s for 30 s | **300,096**; 300,180; 295,904 | 8,980,000 submitted = 8,980,000 completed (8,975,473 ok + 4,527 failed), 0 lost | 71 / 219 / 356 ms | [bench-e2e-300k](reports/bench-e2e-300k/report.md) |
| **Stretch: 1M/s, full system** | same, gateway 8 engine shards | 1,000,000/s for 30 s | **999,378**; 999,471; 982,628 | 29,955,000 submitted = 29,955,000 completed (29,939,976 ok + 15,024 failed), 0 lost | 75 / 223 / 356 ms | [bench-e2e-1m](reports/bench-e2e-1m/report.md) |
| Stretch: 1M/s, engine only | 14 threads, each engine + simulator in-process; JSON bodies still parsed; no HTTP/sockets | 1,000,000/s for 15 s | **1,072,825** (mean includes catch-up); 1,001,264; 962,922 | 13.6M, all completed | 130 / 713 / 1,008 ms | [bench-engine-1m](reports/bench-engine-1m/report.md) |

API ack latency (client side, 5,000-request batches): p50 7.5 ms / p99 26 ms at 300k/s;
p50 8.8 ms / p99 79 ms at 1M/s. The simulated model latency was p50 50–80 ms, so most of
the end-to-end latency is the model's.

All three benchmarks reached their targets on this laptop. The required benchmark ran with
large headroom. The full-system stretch run held ~1M/s with the worst second at 98.3%
of target.

### Contended runs (kept for transparency)

During the final evidence run another program on the machine started several CPU- and
memory-heavy `ffmpeg` jobs (about 3.5 cores each, leaving under 1 GB of free RAM). The
two in-process engine benchmarks run during that window collapsed: the machine was
paging, and the in-process benchmark keeps every result in memory. Those reports are
kept in [bench-engine-1m-contended](reports/bench-engine-1m-contended/report.md) and
[bench-engine-300k-contended](reports/bench-engine-300k-contended/report.md), but they say
nothing about the code. The engine-1m result in the table comes from the same code, run
an hour earlier on an otherwise idle machine. The e2e benchmarks and all scenarios ran
before the contention and met their targets.

---

## Failures and how they were handled (measured)

| Run | Failure mode | Outcome |
| --- | --- | --- |
| Scenario 1 | 0.5% transient, 0.1% permanent provider errors | 1,346 retry attempts; 273 permanent failures; 0 retries exhausted |
| Scenario 2 | Limit cut while the model-a queue was full | 9,133 expired at TTL, 122,536 rejected at admission; 0 limit violations |
| Scenario 3 | 8% transient, 1% timeout (2 s), 2% permanent; callback destination down twice | 238 permanent failures, everything else succeeded after retries; callback delivered on attempt 3 |
| Benchmarks | 0.1% transient, 0.05% permanent | All transient errors recovered; permanent ones reported as failed |

## Bottlenecks

Profiling (`node --cpu-prof`, single engine shard at saturation) showed:

1. **JSON parsing of request bodies (~29% of a shard).** This is the API's inherent cost:
   batches arrive as JSON. Payloads are passed through as strings. A binary or columnar
   ingest format (protobuf, Arrow) would roughly halve the per-request ingest cost.
2. **The in-flight table (was ~10% plus most of the 8% GC).** The original `Map` of
   small objects was replaced by a preallocated typed-array ring keyed by call id
   (`gateway/inflight.js`). In-process throughput went from ~840k/s to ~1.07M/s on
   14 threads.
3. **Result bookkeeping (`onResult` / `_finalize`).** Per-request typed-array writes,
   histogram updates and per-second counters, about 15% together. Already compact.
4. **CPU sharing.** At 1M/s the load generator, the gateway and the simulator all
   compete for 16 hardware threads, and the simulator does about as much work per call as
   the engine. In production the provider is someone else's machine, so a gateway node
   would have all its cores for itself.
5. **Memory for results.** Retaining 30M per-request results takes several GB. That is
   why retention is bounded (`resultRetentionMs`, `maxRetainedRequests`) and why the
   scale-out plan moves results to external storage.

Not bottlenecks: the rate limiter (~1.5% of a shard), the binary protocol, and the
gateway main thread (it only moves body buffers to shards).

## Projection: 10 billion requests per minute (not measured)

10B/min = 166.7M req/s, about 167× the measured single-machine stretch result. Taking
~1M/s per 16-thread machine *including* the simulator, and assuming a real deployment
needs roughly 2× the per-request work for real network I/O, TLS and durability, that comes
to about **330 machines of this class**, or ~100 64-core servers, for the dispatch tier.
Ingest, a partitioned log and lease-based global rate limiting come on top. The
architecture changes needed are in [docs/DESIGN.md §8](docs/DESIGN.md). These numbers are
arithmetic on the measurements above, not measured themselves.

## Reproduce

```bash
npm test                 # 13 unit/property tests
npm run scenario1        # ~6 min
npm run scenario2        # ~7 min
npm run scenario3        # ~40 s
node scenarios/bench.js --mode e2e --rate 300000  --duration 30 --gateway-shards 4 --provider-shards 4 --loadgen-workers 4
node scenarios/bench.js --mode e2e --rate 1000000 --duration 30 --gateway-shards 8 --provider-shards 4 --loadgen-workers 4
node scenarios/bench.js --mode engine --rate 1000000 --duration 15 --shards 14
npm run evidence         # all of the above, in sequence
```

Throughput numbers depend on the machine. Close other CPU-heavy programs first, and
size `--gateway-shards` / `--provider-shards` / `--loadgen-workers` to your core count. Gateway
shards must be a multiple of provider shards.
