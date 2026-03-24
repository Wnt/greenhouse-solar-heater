/**
 * OpenTelemetry tracing initialization.
 * Loaded via --require before server.js to enable auto-instrumentation.
 *
 * If NEW_RELIC_LICENSE_KEY is not set, exits immediately (no-op).
 * When active, auto-instruments: http, pg, @aws-sdk, dns, net.
 * MQTT spans are added manually in mqtt-bridge.js.
 */

var licenseKey = process.env.NEW_RELIC_LICENSE_KEY;
if (!licenseKey) {
  // No license key — skip all telemetry. OTel API returns no-op spans.
  return;
}

var opentelemetry = require('@opentelemetry/sdk-node');
var { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
var { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
var { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
var { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
var { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
var { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');

var endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'https://otlp.nr-data.net';
var serviceName = process.env.OTEL_SERVICE_NAME || 'greenhouse-monitor';

var headers = {
  'api-key': licenseKey,
};

var traceExporter = new OTLPTraceExporter({
  url: endpoint + '/v1/traces',
  headers: headers,
});

var metricExporter = new OTLPMetricExporter({
  url: endpoint + '/v1/metrics',
  headers: headers,
});

var logExporter = new OTLPLogExporter({
  url: endpoint + '/v1/logs',
  headers: headers,
});

var sdk = new opentelemetry.NodeSDK({
  serviceName: serviceName,
  traceExporter: traceExporter,
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

// Graceful shutdown
process.on('SIGTERM', function () {
  sdk.shutdown().catch(function () {});
});
