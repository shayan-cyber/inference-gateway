# Benchmark: end-to-end (HTTP -> gateway -> TCP -> provider simulator) @ 1,000,000 req/s target

Generated 2026-11-11T20:06:23.536Z by `node scenarios/bench.js --mode e2e --rate 1000000 --duration 30 --gateway-shards 8 --provider-shards 4 --loadgen-workers 4`

## Measured
| metric | value |
| --- | --- |
| target submit rate (req/s) | 1,000,000 |
| achieved submit rate (req/s) | 997,204 |
| steady completion rate, mean (req/s) | **999,378** |
| steady completion rate, median / min 1 s (req/s) | 999,471 / 982,628 |
| peak 1 s completions | 1,010,758 |
| steady window (s) | 24 |
| submitted | 29,955,000 |
| accepted / rejected | 29,955,000 / 0 |
| completed (succeeded + failed) | 29,955,000 (29,939,976 + 15,024) |
| expired / still waiting | 0 / 0 |
| accounting balanced | yes |
| retry attempts | 30,055 |
| end-to-end latency p50 / p95 / p99 (ms) | 74.75 / 223.23 / 356.35 |
| provider round trip p50 / p95 / p99 (ms) | 72.7 / 219.14 / 356.35 |
| API ack latency p50 / p99 (ms) | 8.83 / 78.85 |

## Configuration
| setting | value |
| --- | --- |
| rate | 1000000 |
| durationS | 30 |
| batchSize | 5000 |
| tokens | 500 |
| payloadBytes | 32 |
| provider_shards | 4 |
| gateway_shards | 8 |
| loadgen_workers | 4 |

Simulated models: model-a (latency p50 50 ms / p99 250 ms), model-b (p50 80 ms / p99 400 ms), 0.1% transient + 0.05% permanent errors, limits raised to 60B RPM so they do not bind. Traffic split 50/50.

## Environment
| environment | value |
| --- | --- |
| node | v24.15.0 |
| platform | Windows_NT 10.0.26200 (win32/x64) |
| cpu | 12th Gen Intel(R) Core(TM) i5-12500H |
| logical_cpus | 16 |
| memory_gb | 15.6 |

![Completions per second](chart-1.svg)
