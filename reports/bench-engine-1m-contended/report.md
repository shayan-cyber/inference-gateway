# Benchmark: engine + simulator in-process @ 1,000,000 req/s target

Generated 2026-11-11T20:07:51.857Z by `node scenarios/bench.js --mode engine --rate 1000000 --duration 20 --shards 14`

## Measured
| metric | value |
| --- | --- |
| target submit rate (req/s) | 1,000,000 |
| achieved submit rate (req/s) | 122,928 |
| steady completion rate, mean (req/s) | **137,689** |
| steady completion rate, median / min 1 s (req/s) | 10,831 / 0 |
| peak 1 s completions | 1,011,843 |
| steady window (s) | 53 |
| submitted | 10,404,000 |
| accepted / rejected | 10,404,000 / 0 |
| completed (succeeded + failed) | 10,404,000 (10,398,637 + 5,363) |
| expired / still waiting | 0 / 0 |
| accounting balanced | yes |
| retry attempts | 10,424 |
| end-to-end latency p50 / p95 / p99 (ms) | 95.23 / 9306.11 / 34078.72 |
| provider round trip p50 / p95 / p99 (ms) | 87.04 / 5963.78 / 15335.42 |

## Configuration
| setting | value |
| --- | --- |
| rate | 1000000 |
| durationS | 20 |
| batchSize | 2000 |
| tokens | 500 |
| payloadBytes | 32 |
| shards | 14 |

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
