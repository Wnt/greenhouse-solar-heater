/**
 * OpenTelemetry tracing initialization.
 * Loaded via --require before server.js to enable auto-instrumentation.
 *
 * If NEW_RELIC_LICENSE_KEY is not set, exits immediately (no-op).
 * When active, auto-instruments: http, pg, dns, net.
 * (S3 traffic flows through our in-tree s3-client; the http
 * instrumentation captures those calls.)
 * MQTT spans are added manually in mqtt-bridge.js.
 */

const licenseKey = process.env.NEW_RELIC_LICENSE_KEY;
if (!licenseKey) {
  // No license key — skip all telemetry. OTel API returns no-op spans.
  return;
}

const opentelemetry = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { resourceFromAttributes } = require('@opentelemetry/resources');

// Auto-detect EU vs US endpoint from license key prefix (eu01xx = EU)
const defaultEndpoint = licenseKey.startsWith('eu01xx') ? 'https://otlp.eu01.nr-data.net' : 'https://otlp.nr-data.net';
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || defaultEndpoint;
const serviceName = process.env.OTEL_SERVICE_NAME || 'greenhouse-monitor';
const gitCommit = process.env.GIT_COMMIT || 'unknown';

// Resource attributes for service identification in New Relic
const resourceAttrs = { 'service.version': gitCommit };
if (gitCommit !== 'unknown') {
  resourceAttrs['git.commit.sha'] = gitCommit;
}

const headers = {
  'api-key': licenseKey,
};

const traceExporter = new OTLPTraceExporter({
  url: endpoint + '/v1/traces',
  headers,
});

const metricExporter = new OTLPMetricExporter({
  url: endpoint + '/v1/metrics',
  headers,
});

const logExporter = new OTLPLogExporter({
  url: endpoint + '/v1/logs',
  headers,
});

const sdk = new opentelemetry.NodeSDK({
  serviceName,
  resource: resourceFromAttributes(resourceAttrs),
  traceExporter,
  metricReader: new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60000,
  }),
  logRecordProcessor: new BatchLogRecordProcessor(logExporter),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable fs instrumentation — too noisy for static file serving
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

// Log tracing config at startup (visible in container logs)
const msg = JSON.stringify({
  ts: new Date().toISOString(),
  level: 'info',
  component: 'tracing',
  msg: 'OTel SDK started',
  service: serviceName,
  endpoint,
  commit: gitCommit,
});
process.stdout.write(msg + '\n');

// Graceful shutdown
process.on('SIGTERM', function () {
  sdk.shutdown().catch(function () {});
});
