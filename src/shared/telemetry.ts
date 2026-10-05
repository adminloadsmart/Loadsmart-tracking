import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { env } from '../config/env';

let sdk: NodeSDK | null = null;

/**
 * Starts OpenTelemetry tracing (http/express/pg/ioredis/socket.io auto-instrumentation) — only
 * when OTEL_EXPORTER_OTLP_ENDPOINT is set, so local dev and CI pay nothing for it. Must run
 * before the instrumented libraries are first used, i.e. first thing in entrypoints/main.ts.
 */
export function startTelemetry(): boolean {
  if (!env.otelExporterEndpoint || sdk) return false;

  sdk = new NodeSDK({
    serviceName: env.serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${env.otelExporterEndpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem spans are pure noise for this service.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });
  sdk.start();
  return true;
}

export async function stopTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
}
