# Observability (OpenTelemetry + Centralized Logging)

## What is enabled
- OpenTelemetry auto-instrumentation (HTTP/Express/MySQL and more)
- Structured JSON logging via `pino`
- Request correlation IDs (`x-correlation-id`)
- Trace/span fields included in log lines when context is available
- Baggage fields included in log lines when present
- Non-blocking file log writes to `logs/eventmagic-api.log`
- API emits local structured logs that are consumed by external loghub repo/container

## Environment variables
- `OTEL_ENABLED=true|false` (default: enabled)
- `OTEL_SERVICE_NAME=magic-event-api`
- `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318` (optional, for central collector)
- `OTEL_DIAGNOSTIC_LOG=true|false`
- `LOG_LEVEL=info|warn|error|debug`
- `LOG_DIR=/app/logs` (optional)
- `LOG_FILE=/app/logs/eventmagic-api.log` (optional)

## Future OpenSearch integration
Recommended production path:
1. API -> local file (`/app/logs/eventmagic-api.log`)
2. External loghub service (separate repo/container) tails and centralizes logs
3. External loghub output can be switched to OpenSearch
3. Use correlation fields (`trace_id`, `span_id`, `correlation_id`) for cross-service debugging.

## Microservice notes
- Forward incoming `x-correlation-id`, `traceparent`, and `baggage` headers when calling downstream services.
- This keeps traces linked and baggage propagated across service boundaries.
