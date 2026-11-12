# inference-gateway

A high-throughput inference dispatch service that keeps every model within its
**current** RPM/TPM limits. It comes with a provider simulator, a load generator,
three repeatable validation scenarios and throughput benchmarks.

Plain Node.js (≥ 20), **no dependencies**: clone and run.

* **Throughput:** sends at the provider's limit instead of ~600 RPM. Scenario 1 completes
  98% of a 50,000 RPM allowance with no 60 s window over the limit.
* **Limits can change while it runs:** the gateway follows the provider's limits (polling,
  plus an immediate re-read on a 429), and operators can cap a model below them without
  a restart.
* **Defined overload behaviour:** bounded per-model queues, 429 + `Retry-After` admission
  control, TTL expiry, retries with backoff. Every request ends up exactly one of
  completed / waiting / expired / rejected.
* **Async batches:** 202 ack in milliseconds, background processing, completion
  callback with retries and an idempotency key, status and paged results API.
* **Evidence:** every scenario writes a report (Markdown, JSON, SVG charts) under
  `reports/` and fails loudly if a check fails.

| | Result | Evidence |
| --- | --- | --- |
| Scenario 1: reach provider capacity | **PASS**: 97.5% of 50k RPM completed; trailing-60 s max 49,218 / 50,000; every request accounted for | [reports/scenario1](reports/scenario1/report.md) |
| Scenario 2: two models, changing limits | **PASS**: 0 windows over the limit in force; cut applied in 452 ms, restore in 303 ms, no restart; model-b steady at 19.6k RPM throughout | [reports/scenario2](reports/scenario2/report.md) |
| Scenario 3: async batch + callback | **PASS**: ack in 31 ms; callback delivered on attempt 3, after all 10,000 requests were final; summary matches API; every id exactly once | [reports/scenario3](reports/scenario3/report.md) |
| Required: 300k req/s | **300,096/s** sustained end to end (HTTP → gateway → TCP → provider sim), 8.98M requests, 0 lost | [reports/bench-e2e-300k](reports/bench-e2e-300k/report.md) |
| Stretch: 1M req/s | **999,378/s** sustained end to end (worst second 982,628), 29.96M requests, 0 lost | [reports/bench-e2e-1m](reports/bench-e2e-1m/report.md) |

Design and tradeoffs: [docs/DESIGN.md](docs/DESIGN.md). Benchmark report: [BENCHMARK.md](BENCHMARK.md).

---

## Quick start

```bash
node --version          # v20 or newer (developed on v24)
npm test                # unit + property tests (~2 s)
npm run stack           # provider sim + gateway + callback receiver, Ctrl+C to stop
```

Then open the dashboard at **http://127.0.0.1:8000/**. It shows live per-model throughput
against the limit, queue depth, latency, and has a form to cap a model's limits.

In another terminal, send some traffic:

```bash
node src/loadgen/cli.js --rate 1200 --duration 60 --models model-a:0.6,model-b:0.4 --batch-size 100 --tokens 1000
```

## Running the pieces separately

### 1. Provider simulator

```bash
node src/provider/server.js --config config/provider.default.json --port 9000 --shards 1
```

* Control API on `:9000`; data plane on TCP `9100..9100+shards-1` (binary, pipelined).
* `GET /v1/models`, `POST /v1/models`, `PATCH /v1/models/:name`, `GET /v1/metrics`,
  `GET /v1/limit-history`, `GET /v1/shards`.

Model configuration (`config/*.provider.json`):

```json
{
  "name": "model-a",
  "rpm": 30000,
  "tpm": 60000000,
  "latency":  { "distribution": "lognormal", "median_ms": 300, "p99_ms": 2000, "min_ms": 20, "max_ms": 30000, "per_1k_tokens_ms": 0 },
  "outcomes": { "transient_error_rate": 0.005, "permanent_error_rate": 0.001, "timeout_rate": 0, "timeout_ms": 5000 },
  "output_tokens_ratio": 0.25
}
```

`latency.distribution` is `lognormal` (median + p99), `fixed` (median) or `uniform` (min..max).
The simulator enforces RPM and TPM itself with a strict trailing-60 s window (calls over
the limit get a 429). Outcomes are drawn from a seeded RNG (`--seed`), so runs are
repeatable.

### 2. Gateway

```bash
node src/gateway/server.js --port 8000 --provider http://127.0.0.1:9000 --shards 1 --config config/gateway.default.json
```

On start it reads the models and limits from the provider, then keeps them in sync
(`--limit-sync-ms 1000`). Engine options (queue wait bound, TTL, retries, callback retry
policy, retention) are in `config/gateway.default.json`.

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/requests` (alias `POST /inference`) | One request: `{model, estimated_tokens, payload, request_id?, ttl_ms?, max_attempts?}` → 202 `{id, status_url}`. Add `?wait=true` to block until final. |
| `GET /v1/requests/:id` | Status / result of a single request. |
| `POST /v1/batches` | `{requests: [...], callback_url?, ttl_ms?, max_attempts?, metadata?}` → 202 `{batch_id, status_url, results_url}` |
| `GET /v1/batches/:id` | Summary: status, total / succeeded / failed / waiting, counts per state, timings, callback delivery state and attempt history. |
| `GET /v1/batches/:id/results?offset=&limit=` | Paged per-request results. |
| `GET /v1/models` | Provider limit, operator cap, effective limit, queue depth, trailing-60 s usage, latency. |
| `PUT /v1/models/:name/limits` | Operator cap `{rpm?, tpm?}` (`null` clears). Effective = min(provider, cap). |
| `GET /v1/stats?series=1` | Totals, latency percentiles, batch/callback timing, per-model per-second series. |
| `GET /v1/limit-history` | Every effective-limit change and where it came from. |
| `GET /` | Live dashboard. |

Errors: `400` validation (unknown model, bad tokens, duplicate `request_id`, bad
`callback_url`); `413` batch too large; `429` + `Retry-After` when a model's backlog
already exceeds the max queue wait (default 30 s). Admission is **per model**: in a mixed
batch only the congested model's requests are refused (state `rejected`, listed in the
202 as `rejected` / `rejected_by_model`), and the rest are processed. A batch gets a 429 only
if nothing in it can be accepted, or if it was sent with `"admission": "all_or_nothing"`.

Example:

```bash
curl -s -X POST localhost:8000/v1/batches -H 'content-type: application/json' -d '{
  "callback_url": "http://127.0.0.1:9900/callback",
  "requests": [
    {"request_id": "doc-1", "model": "model-a", "estimated_tokens": 1000, "payload": {"prompt": "..."}},
    {"request_id": "doc-2", "model": "model-b", "estimated_tokens": 800,  "payload": {"prompt": "..."}}
  ]}'
curl -s localhost:8000/v1/batches/<batch_id>
curl -s localhost:8000/v1/batches/<batch_id>/results
```

Callback body (sent once every request is final; retried on non-2xx with backoff;
headers `Idempotency-Key: <batch_id>`, `X-Callback-Attempt: n`):

```json
{
  "event": "batch.completed",
  "batch_id": "b0_1h53k",
  "status": "completed_with_failures",
  "total": 10000, "succeeded": 9762, "failed": 238,
  "failure_breakdown": {"provider_or_retries": 238, "expired": 0},
  "waiting": 0,
  "counts": {"queued": 0, "in_flight": 0, "retry_wait": 0, "succeeded": 9762, "failed": 238, "expired": 0},
  "created_at": "…", "completed_at": "…", "duration_ms": 24726,
  "results_url": "http://127.0.0.1:8000/v1/batches/b0_1h53k/results",
  "results": [{"request_id": "s3-00000", "model": "model-a", "status": "succeeded", "attempts": 1, "latency_ms": 312, "output_tokens": 250, "error": null}, "…"]
}
```

`status` is `completed` (all succeeded), `completed_with_failures` or `failed` (none
succeeded). Results are inline up to 10,000 requests, otherwise `results` is `null` and
`results_url` pages them.

### 3. Load generator

```bash
node src/loadgen/cli.js --rate 2000 --duration 60 \
  --models model-a:0.7,model-b:0.3 --batch-size 100 --tokens 1000 --token-jitter 0.2 \
  [--mode batch|single] [--payload-bytes 64] [--concurrency 64] [--workers 1] \
  [--callback-url http://127.0.0.1:9900/callback] [--out reports/my-run]
```

It submits open-loop at `--rate` requests/s for `--duration` s, waits for the gateway to
drain, then prints the run report: submitted / completed / succeeded / failed / expired /
rejected, completion rate, p50/p95/p99 latency (end-to-end and provider round trip),
configured vs observed RPM and TPM per model (observed = the provider simulator's own
counts), and batch completion and callback timing.

## Configuring models and changing limits at runtime

* **Provider limits** (what the provider allows). Edit `config/*.provider.json`, or change
  them live:
  ```bash
  curl -X PATCH localhost:9000/v1/models/model-a -H 'content-type: application/json' -d '{"rpm": 5000}'
  curl -X POST  localhost:9000/v1/models          -H 'content-type: application/json' -d '{"name": "model-c", "rpm": 1000, "tpm": 2000000}'
  ```
  The gateway notices within a second (or immediately on a 429) and adjusts without a
  restart. New models are discovered the same way.
* **Operator caps** (our own ceiling, e.g. to reserve capacity). Use the dashboard form, or:
  ```bash
  curl -X PUT localhost:8000/v1/models/model-a/limits -H 'content-type: application/json' -d '{"rpm": 10000, "tpm": null}'
  ```

## Validation scenarios

Each scenario starts its own provider and gateway processes, runs, checks the pass
criteria, writes `reports/<scenario>/report.{md,html,json}` plus SVG charts, and exits
non-zero on failure. Ports 8000, 9000, 9100+ and 9900 must be free.

| Command | What it does | Runtime |
| --- | --- | --- |
| `npm run scenario1` | model-a at 50,000 RPM / 100M TPM; 1,000-token requests at 1,000 req/s (120% of capacity) for 5 min. Checks ≥ 90% of capacity used after warm-up, no 60 s window over either limit, every request accounted for. | ~6 min |
| `npm run scenario2` | model-a 30k RPM / 60M TPM and model-b 20k / 40M, both overloaded. The provider cuts model-a to 5,000 RPM at 2 min and restores it at 4 min. Checks per-model limits, adjustment without restart, model-b unaffected; time series and charts. | ~7 min |
| `npm run scenario3` | One 10,000-request batch over two models with 8% transient errors, 1% timeouts and 2% permanent errors; the callback receiver rejects the first 2 attempts. Checks ack < 1 s, callback only after all requests are final, delivery on the 3rd attempt, callback matches the status API, every request id exactly once. | ~40 s |

Shorter variants for a quick look: `node scenarios/scenario1.js --duration 90 --warmup 20`
and `node scenarios/scenario2.js --phase 70`.

## Throughput benchmarks

```bash
# full system: loadgen --HTTP--> gateway (4 engine shards) --TCP--> provider sim (4 shards)
node scenarios/bench.js --mode e2e --rate 300000 --duration 30 --gateway-shards 4 --provider-shards 4 --loadgen-workers 4

# engine + simulator in-process (no HTTP/sockets), many shards
node scenarios/bench.js --mode engine --rate 1000000 --duration 20 --shards 12
```

The models' limits are raised so they don't bind (`config/bench.provider.json`). A request
counts only once its simulated provider call reached a final state and the engine
recorded it. See [BENCHMARK.md](BENCHMARK.md) for results, environment and bottlenecks.

## Repository layout

```
src/common/     limiter (sliding window + pacing), histogram, binary protocol, series, model config
src/provider/   simulator: control API (server.js), shard threads (shard-worker.js), simulation core (sim.js)
src/gateway/    HTTP API (server.js), engine shard (engine.js, engine-worker.js), provider client, callbacks, dashboard
src/loadgen/    open-loop load generator (loadgen.js) and CLI (cli.js)
src/report/     metric analysis (limit checks against the provider's records) and report rendering
scenarios/      scenario1-3, bench, stack (demo), callback-sink, shared harness
config/         provider configs per scenario, gateway engine options
reports/        generated evidence (committed)
test/           unit and property tests (node:test)
docs/DESIGN.md  architecture, limit semantics, overload behaviour, tradeoffs, 10B/min plan
```

## Key design decisions (summary)

Details and the tradeoff table are in [docs/DESIGN.md](docs/DESIGN.md).

1. **Decouple accepting from sending.** Accept fast (202), queue per model, dispatch each
   model at its current limit.
2. **Never exceed, provably.** A strict trailing-60 s window guard (conservative 60.1 s)
   on requests and tokens, plus pacing at 98% so the guard rarely binds. A limit cut
   pauses the model until its trailing minute drains below the new limit.
3. **The provider is the source of truth for limits.** Poll it, re-read on 429, never
   charge a 429 to the request. Operators can only cap below it.
4. **Bounded overload.** Per-model admission control by estimated queue wait (a
   congested model's requests are refused individually; 429 + Retry-After only when nothing
   fits), TTL expiry, retries with backoff and jitter, permanent errors fail fast.
5. **Every request accounted for.** One state machine per request; reports check
   `submitted = completed + waiting + expired + rejected`.
6. **Scale up by sharding.** One engine shard per worker thread, each holding `limit / N`.
   A pipelined binary protocol to the provider keeps per-call overhead to microseconds.
7. **Measure at the provider.** Limit compliance is checked against the simulator's own
   records, not the gateway's view.

## Simulation assumptions

* Latency and outcomes are sampled per call from the configured distributions with a
  seeded RNG; provider capacity is unlimited apart from the RPM/TPM limits.
* TPM is charged on `estimated_tokens` at admission, as providers that reserve
  `max_tokens` do. Output tokens are reported (`output_tokens_ratio`) but not charged.
* Everything runs on one machine over loopback, so network latency is about zero and
  every process shares the same CPUs.
* Throughput benchmarks raise the limits so they don't bind; the scenarios use the
  limits the assignment specifies.
