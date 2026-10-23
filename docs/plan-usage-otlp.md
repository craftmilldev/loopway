# Plan usage over OTLP

A small, open format for reporting how much of an account's plan usage windows (the 5-hour and 7-day limits of a coding-agent subscription) has been used. It is plain OTLP metrics with neutral names, so any tool can emit it and any OTLP receiver can read it. Nothing in it names a producer or a consumer.

## Metric

One gauge, sent as OTLP/HTTP (`POST <endpoint>/v1/metrics`, JSON body).

| Name | Type | Unit | Meaning |
| --- | --- | --- | --- |
| `plan.usage.utilization` | gauge | `1` | the share of a window used, from 0 to 1 |

One data point per window. Attributes on each point:

| Attribute | Type | Meaning |
| --- | --- | --- |
| `plan.window` | string | `5h`, `7d`, or the source's own name for any other window (for example a model-specific weekly window) |
| `plan.resets_at` | int | when the window resets, unix seconds; left out when unknown |
| `plan.provider` | string | who sells the plan, such as `anthropic` |
| `session.id` | string | the agent session that saw the numbers, so a receiver can join them to that session's own telemetry |
| `plan.status` | string | `allowed`, `allowed_warning` or `rejected`; only on the window the source's event names, and only when known |

Resource attributes are the producer's usual ones: `service.name`, plus whatever `OTEL_RESOURCE_ATTRIBUTES` holds. Metric names never carry a producer's name, and a receiver must not need `service.name` to understand the points.

A producer that does not know a window's utilization leaves the point out rather than guessing.

## Configuration

Only the standard OpenTelemetry exporter variables: `OTEL_EXPORTER_OTLP_ENDPOINT` (the path `/v1/metrics` is added) or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (used as is), `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, `OTEL_RESOURCE_ATTRIBUTES`. `OTEL_SDK_DISABLED=true` or `OTEL_METRICS_EXPORTER=none` turns it off. With no endpoint set, nothing is sent. Only HTTP is supported: `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` sends nothing.

## How loopway produces it

Claude Code's status line is the only place plan usage shows up in its own output, and headless `claude -p` runs never run it. But their stream-json carries a `rate_limit_event` whose `rate_limit_info` holds `status`, `resetsAt`, `rateLimitType` and `unifiedWindows`, a map from window name (`five_hour`, `seven_day`, `seven_day_overage_included`, ...) to its `utilization` (0 to 1) and `resetsAt`. A bot run reads every such event and reports a snapshot of `unifiedWindows`: `five_hour` becomes `5h`, `seven_day` becomes `7d`, any other key is passed through.

- At most one report a minute per runner; a `rejected` event always reports.
- A `rejected` event without `unifiedWindows` reports the window named by `rateLimitType` at 1, but only while its `resetsAt` is still in the future and `rateLimitType` is not `overage`. A rejected overage allowance (`overageStatus`, `overageDisabledReason`) says nothing about the window, and a `resetsAt` already past means the event is stale, so both leave the point out.
- Sending is asynchronous with a 3 second timeout. A run never waits for it or fails because of it, and an unreachable endpoint is logged once and then ignored.

To try it, point a runner at an OpenTelemetry Collector with the `debug` exporter:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 loopway bots run
```
