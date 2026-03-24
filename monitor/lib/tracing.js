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

// Auto-detect EU vs US endpoint from license key prefix (eu01xx = EU)
var defaultEndpoint = licenseKey.startsWith('eu01xx') ? 'https://otlp.eu01.nr-data.net' : 'https://otlp.nr-data.net';
var endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || defaultEndpoint;
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

// Wrap trace exporter to log first export result for diagnostics
var origExport = traceExporter.export.bind(traceExporter);
var exportLogged = false;
traceExporter.export = function (spans, resultCallback) {
  if (!exportLogged) {
    exportLogged = true;
    origExport(spans, function (result) {
      var logEntry = JSON.stringify({
        ts: new Date().toISOString(),
        level: result.code === 0 ? 'info' : 'error',
        component: 'tracing',
        msg: 'first trace export ' + (result.code === 0 ? 'succeeded' : 'FAILED'),
        code: result.code,
        error: result.error ? result.error.message : undefined,
        spans: spans.length,
      });
      process.stdout.write(logEntry + '\n');
      resultCallback(result);
    });
  } else {
    origExport(spans, resultCallback);
  }
};

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

// Log tracing config at startup (visible in container logs)
var msg = JSON.stringify({
  ts: new Date().toISOString(),
  level: 'info',
  component: 'tracing',
  msg: 'OTel SDK started',
  service: serviceName,
  endpoint: endpoint,
});
process.stdout.write(msg + '\n');

// Graceful shutdown
process.on('SIGTERM', function () {
  sdk.shutdown().catch(function () {});
});
