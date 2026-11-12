# Design notes

This document explains how the system works and why it is built this way. Measured
numbers live in [BENCHMARK.md](../BENCHMARK.md); the scaling section at the end is a
**projection**, labelled as such.

## 1. The problem in one paragraph

The original client sent one request at a time and slept 100 ms in between, so it could
never exceed ~600 RPM while the provider allows 50,000 RPM and 100M TPM. The fix is not
"send faster". It is to decouple **accepting** work from **sending** work: accept as
fast as clients can submit, queue per model, and dispatch each model exactly as fast as
its *current* limits allow. Every request has to be tracked to a final state along the way.

## 2. Components

```
                 HTTP/JSON                        binary TCP (pipelined)
 clients ──────────────────► gateway ─────────────────────────────────► provider simulator
 load generator   POST /v1/batches   main thread: HTTP, routing,          control API (HTTP)
                  POST /v1/requests  limit sync, stats aggregation        N shards, each:
                  GET  status/results     │ round-robin per submission      - RPM/TPM enforcement (429)
                                          ▼                                 - sampled outcome + latency
                                     engine shard 0..E-1 (worker threads)   - 1 ms timing wheel
                                       per model: FIFO queue, limiter,
                                       in-flight table, retry wheel,
                                       batch tracking, callbacks
```

* **Gateway main thread** (`src/gateway/server.js`) terminates HTTP and forwards each raw
  request body to an engine shard, round-robin. It never parses batch bodies itself, so it
  stays cheap. Status lookups go to the shard encoded in the id (`b<shard>_…`).
* **Engine shard** (`src/gateway/engine.js`, one per worker thread) parses and validates a
  submission, applies admission control, queues requests per model, dispatches through the
  limiter, handles results and retries, completes batches and sends callbacks.
* **Provider simulator** (`src/provider/`) is a separate process with N shard threads. It
  enforces RPM/TPM itself (answers 429 when exceeded), so the limit checks in the
  reports come from the provider's own records, not from the gateway's.
* **Load generator** (`src/loadgen/`) is an open-loop generator: it submits at the target
  rate whatever the gateway's completion rate, and counts every request as accepted,
  rejected or errored.

## 3. Respecting limits

### Two layers

`ModelLimiter` (`src/common/limiter.js`) has:

1. **Pacing**: token buckets for requests and tokens that refill at `utilization × limit / 60 s`
   (default 98%) with a 250 ms burst. Traffic goes out evenly instead of spending the
   whole minute's budget in the first second.
2. **Hard guard**: strict trailing-60 s sliding windows (600 × 100 ms buckets plus one extra
   bucket) for requests *and* tokens. A request is admitted only if
   `window + this request ≤ current limit`. The extra bucket makes the window 60.1 s,
   so the check is conservative: no 60 s period at any alignment can contain more than
   the limit.

Pacing makes the guard almost never the thing that binds. Steady state is about 98.4% of
the limit in any 60 s window. The guard is what turns "usually under" into "never over".

A randomised property test (`test/limiter.test.js`) checks this with arbitrary arrival
patterns and random limit changes, at 1 ms resolution.

### What "current limit" means when limits change

When a limit drops (e.g. 30,000 → 5,000 RPM), the trailing minute already holds about
29,000 requests. The strict definition we use is: *a request may be admitted only if
the trailing 60 s including it stays within the limit in force at that moment.* So after a
reduction the model **pauses** until enough of the last minute ages out, then runs at the
new rate. That is the only behaviour that keeps every 60 s window ending after the change
under the new limit. Increases take effect immediately.

The alternative is to start sending at 5,000/60 per second straight away. That looks
smoother, but windows straddling the change then hold up to ~34,000 requests against a
5,000 limit. Against a real provider those calls would be 429s anyway.

### Where limits come from

* The provider is the source of truth. The gateway polls `GET /v1/models` on the provider
  every second, and re-reads at once when any call comes back 429 (stale-limit signal).
* Operators can set a **cap** per model (`PUT /v1/models/:name/limits`, or the dashboard).
  Effective limit = `min(provider limit, operator cap)`. This lets you reserve capacity
  for another system, or cut a model's spend, without touching the provider.
* A 429 from the provider is never charged to the request: it doesn't use up an
  attempt. The model pauses for 250 ms and the request goes back to the front of the queue.

### Sharding the limit

With E engine shards each shard enforces `limit / E`. Submissions are round-robin across
shards, so demand is balanced and the shares sum to the limit. The provider simulator is
sharded the same way. E must be a multiple of the provider shard count P, and gateway
shard i talks to provider shard i mod P. The validation scenarios run with one shard
(their rates are ~1k/s); only the throughput benchmarks shard.

Tradeoff: a static split wastes capacity if demand is skewed across shards (one shard's
queue is empty while another's is full). With round-robin ingestion that doesn't happen
in practice. Section 8 covers the general fix, lease-based allocation.

## 4. When demand exceeds capacity

The system has a defined response at each level:

| Situation | Behaviour |
| --- | --- |
| Short burst above the limit | Queued per model, FIFO. Clients see 202 at once; the queue drains at the limit. |
| Sustained overload | **Admission control, per model**: if a model's existing backlog would take longer than `maxQueueWaitMs` (default 30 s) to drain at its current rate, new requests *for that model* are refused. Inside a mixed batch only that model's requests are refused (final state `rejected`, error `model_over_capacity`; the 202 lists `rejected_by_model` with a `retry_after_s`), so one constrained model never blocks the others. A batch where nothing can be accepted, a single request, or a batch sent with `"admission": "all_or_nothing"` gets **429 + `Retry-After`**. The queue stays bounded in *time*, so it adapts automatically when limits change. A batch into an empty queue is always accepted. |
| A request waits past its TTL (`ttl_ms`, default 120 s) | Marked **expired** (final state, never sent). The batch can still complete. |
| Provider transient error / timeout | Retried with exponential backoff and jitter (100 ms base, 4 attempts default), then **failed** (`retries_exhausted`). |
| Provider permanent error | **Failed** at once (`provider_permanent_error`). |
| Provider 429 | Not charged to the request; the model backs off 250 ms and limits are re-read. |
| Provider connection lost | All in-flight calls on it are retried; dispatch pauses until reconnected. |
| No answer in `callTimeoutMs` (65 s) | Treated as a timeout and retried. |

Every request is therefore always in exactly one of: `queued`, `in_flight`, `retry_wait`
(together these are *waiting*), or a final state: `succeeded`, `failed`, `expired`,
`rejected` (refused at admission; never sent). Requests in a batch answered with a 429 are
also counted as `rejected`. Every report checks
`submitted = completed + waiting + expired + rejected`.

## 5. Async batches and callbacks

* `POST /v1/batches` validates, runs admission control, enqueues and returns **202** with
  `batch_id`, `status_url` and `results_url`. Measured: 23–31 ms for a 10,000-request,
  1.1 MB batch.
* Per-request state is held in compact typed arrays per batch (state, attempts, error,
  latency, output tokens). Request ids are stored only when the client supplies them;
  otherwise they are derived (`<batch_id>-<index>`).
* When a batch's last request becomes final, the callback is queued. The body (summary
  plus inline results up to 10,000 requests, otherwise only `results_url`) is built once
  from the **same function** that serves `GET /v1/batches/:id`, so the two cannot disagree.
* Delivery: `POST callback_url` with `Idempotency-Key: <batch_id>` and
  `X-Callback-Attempt: n`. Any non-2xx, network error or 10 s timeout is retried with
  backoff (1 s, 2 s, 4 s, … capped at 60 s, ±20% jitter, 8 attempts). Then it is
  marked `failed`; the batch stays queryable. Delivery state and every attempt are
  visible in `GET /v1/batches/:id`.
* Results are kept for `resultRetentionMs` (1 h) or until `maxRetainedRequests` is
  exceeded, oldest completed batch first. A batch with a callback still pending is never
  evicted.

## 6. Why the gateway↔provider hop is binary and pipelined

At 300k+ calls/s, one HTTP request per call costs far more CPU than the work being
simulated. Engine shards keep one persistent TCP connection per provider shard and write
one frame per model per dispatch tick holding many calls. Results come back in frames as
their simulated latencies elapse. Each call still has its own id, outcome and latency, and
can complete in any order. This is the same idea as HTTP/2 multiplexing or a provider batch
endpoint. Backpressure works too: if the socket buffer fills, the engine stops dispatching,
and so stops spending rate-limit budget, until it drains.

Real providers expose HTTP/JSON APIs. Talking to one would put an HTTP client pool behind
the same `enqueue/flush` interface (`src/gateway/provider-client.js`); at real-world
rates (~1k req/s per model) that costs nothing.

## 7. Choices and tradeoffs

| Choice | Why | Cost |
| --- | --- | --- |
| Node.js, no runtime dependencies | Easy to run and review (`node` ≥ 20, nothing to install). Async I/O fits a dispatch service. | One thread per event loop, hence worker-thread shards and care in hot paths (typed arrays, no per-request closures). |
| In-memory state per shard | Simplest correct design for one node; zero-copy lookups. | State is lost on a crash. A production version persists acceptance (see §8). |
| Strict sliding window plus pacing | Provably never over the limit, yet ~98% utilisation. | After a limit cut the model pauses up to 60 s. |
| Admission control by time, not queue length | Bounds latency, and follows limit changes automatically. | Clients must handle 429 + Retry-After. |
| Per-model partial acceptance of batches (default) | A congested model must not block others: scenario 2 caught exactly this when whole-batch 429s starved model-b while model-a was cut to 5k RPM. | Clients must read `rejected` in the 202 (or use `admission: all_or_nothing`). |
| Static per-shard limit split | No cross-thread coordination on the hot path. | Needs balanced ingestion (round-robin gives it). |
| Seeded simulator RNG | Repeatable runs. | None. |
| Latency measured from acceptance | Tells you what the client actually experiences, queueing included. Provider round trip is reported separately. | Under deliberate overload, end-to-end latency is dominated by the (bounded) queue wait. |

## 8. Toward 10 billion requests per minute (projection, not measured)

10B/min = **166.7M requests/s**. Measured per-core numbers for this code are in
BENCHMARK.md; the arithmetic below uses them only to size things.

**What changes.**

1. **Stateless ingest tier behind a load balancer.** API nodes validate and write
   batches to a **partitioned durable log** (Kafka, Redpanda or Kinesis), keyed by
   `(model, tenant)`, then ack. Acks then survive a crash, and ingest scales separately
   from dispatch. At ~100 bytes/request that is ~17 GB/s across the cluster:
   hundreds of partitions, compressed, columnar batch encoding instead of JSON.
2. **Dispatcher tier = this engine.** Each dispatcher owns a set of log partitions
   (consumer-group assignment gives failover) and runs exactly the per-model
   queue → limiter → provider pipeline here.
3. **Hierarchical, lease-based rate limiting** in place of the static split. A small
   **limit coordinator** per model (Raft-replicated, or Redis with Lua) holds the global
   sliding window and hands out **leases**: "you may send X requests / Y tokens in the next
   200 ms", sized to each dispatcher's reported backlog. Dispatchers enforce leases
   locally with the same limiter. Unused lease is returned or simply expires.
   Coordination is then O(dispatchers × 5/s), not O(requests). The global guarantee holds
   because the coordinator only grants from its own conservative window. A 10B/min
   aggregate is necessarily spread across many models, providers, regions and accounts;
   each `(provider, account, model)` limit gets its own coordinator.
4. **Provider connectivity.** Pooled HTTP/2 or gRPC connections per provider endpoint,
   using provider batch APIs where offered. Egress is sharded per region.
5. **Results and callbacks.** Results are written to a column store or object storage
   (Parquet per batch) with a small index, not kept in memory. Callbacks become their
   own queue-driven delivery service with per-destination concurrency limits and
   circuit breakers, so one slow receiver cannot back up the rest.
6. **Observability.** The per-model metrics here become Prometheus/OTel counters; the
   trailing-window audit becomes a streaming job checking the provider-side counts.

**Sizing (projection).** Measured on one 16-thread laptop: ~1M completions/s end to end,
with the load generator and the provider simulator on the same machine (BENCHMARK.md).
Assume a production dispatcher needs about 2× the CPU per request for real network
I/O, TLS and durable acks. Then 166.7M/s needs about 330 machines of that class, roughly
**100 servers with 64 cores**, for dispatch, plus an ingest tier and a log cluster of
similar order. These figures assume the providers actually offer 166.7M/s of capacity
across the relevant models, which is the real constraint.

**What does not change:** the per-request state machine, the limiter semantics and the
accounting identity `submitted = completed + waiting + expired + rejected`.
