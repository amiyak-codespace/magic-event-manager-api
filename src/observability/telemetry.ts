import { diag, DiagConsoleLogger, DiagLogLevel, propagation } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | null = null;

export function initTelemetry(): void {
  if (sdk || process.env.OTEL_ENABLED === 'false') return;

  if (process.env.OTEL_DIAGNOSTIC_LOG === 'true') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
  }

  const serviceName = process.env.OTEL_SERVICE_NAME || 'magic-event-api';
  const serviceVersion = process.env.npm_package_version || '1.0.0';
  const environment = process.env.NODE_ENV || 'development';

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: environment,
  });

  const traceExporter = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OTLPTraceExporter({
        url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`,
      })
    : undefined;

  sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = async () => {
    if (!sdk) return;
    try {
      await sdk.shutdown();
    } catch {
      // no-op
    }
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  // force module load so baggage propagation is available globally
  void propagation;
}
