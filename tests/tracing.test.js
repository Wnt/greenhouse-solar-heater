const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const tracingPath = path.resolve(__dirname, '../server/lib/tracing.js');

describe('tracing module', () => {

  describe('graceful no-op when no license key', () => {
    it('should exit without errors when NEW_RELIC_LICENSE_KEY is not set', () => {
      // Run tracing.js as a subprocess with no license key.
      // It should exit 0 with no output.
      const result = execFileSync('node', ['-e', 'require("' + tracingPath.replace(/\\/g, '\\\\') + '")'], {
        env: { ...process.env, NEW_RELIC_LICENSE_KEY: '' },
        encoding: 'utf-8',
        timeout: 10000,
      });
      // Should complete without throwing
      assert.strictEqual(typeof result, 'string');
    });

    it('should not throw when required via --require without license key', () => {
      // Simulate the Dockerfile CMD pattern
      const result = execFileSync('node', [
        '--require', tracingPath,
        '-e', 'process.exit(0)',
      ], {
        env: { ...process.env, NEW_RELIC_LICENSE_KEY: '' },
        encoding: 'utf-8',
        timeout: 10000,
      });
      assert.strictEqual(typeof result, 'string');
    });
  });

  describe('OTel API no-op behavior', () => {
    it('should return no-op tracer when SDK is not initialized', () => {
      const api = require('@opentelemetry/api');
      const tracer = api.trace.getTracer('test');
      const span = tracer.startSpan('test-span');
      // No-op span should exist and be callable
      assert.ok(span);
      assert.strictEqual(typeof span.end, 'function');
      span.end();
    });

    it('should return invalid span context when no active span', () => {
      const api = require('@opentelemetry/api');
      const spanContext = api.trace.getSpan(api.context.active());
      // Should be undefined when no active span
      assert.strictEqual(spanContext, undefined);
    });
  });
});

describe('MQTT spans', () => {
  it('should create no-op spans without errors when OTel SDK is not initialized', () => {
    // Clear module cache to get fresh mqtt-bridge with OTel API
    delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
    const mqttBridge = require('../server/lib/mqtt-bridge.js');

    // handleStateMessage uses no tracer spans directly, but the message handler does.
    // Calling handleStateMessage directly should not throw even without OTel SDK.
    mqttBridge._reset();
    mqttBridge.handleStateMessage({ ts: Date.now(), temps: {}, mode: 'idle' });
    // No assertion needed — if it throws, the test fails
  });

  it('should have tracer available via @opentelemetry/api', () => {
    const api = require('@opentelemetry/api');
    const tracer = api.trace.getTracer('mqtt-bridge');
    assert.ok(tracer);

    // Create a span like mqtt-bridge does
    const span = tracer.startSpan('mqtt.message', {
      attributes: { 'messaging.system': 'mqtt', 'messaging.destination': 'greenhouse/state' },
    });
    assert.ok(span);
    assert.strictEqual(typeof span.end, 'function');
    span.end();
  });
});

describe('logger trace context injection', () => {
  it('should not include trace.id or span.id when no active span', () => {
    delete require.cache[require.resolve('../server/lib/logger.js')];
    const createLogger = require('../server/lib/logger.js');
    const log = createLogger('test');

    // Capture stdout
    let captured = '';
    const origWrite = process.stdout.write;
    process.stdout.write = function (chunk) { captured += chunk; };
    try {
      log.info('test message', { foo: 'bar' });
    } finally {
      process.stdout.write = origWrite;
    }

    const entry = JSON.parse(captured);
    assert.strictEqual(entry.msg, 'test message');
    assert.strictEqual(entry.foo, 'bar');
    assert.strictEqual(entry['trace.id'], undefined);
    assert.strictEqual(entry['span.id'], undefined);
  });

  it('should not throw when within active span (no-op tracer)', () => {
    delete require.cache[require.resolve('../server/lib/logger.js')];
    const createLogger = require('../server/lib/logger.js');
    const log = createLogger('test');
    const api = require('@opentelemetry/api');
    const tracer = api.trace.getTracer('test-logger');

    // No-op tracer returns invalid span context (all-zero traceId).
    // The logger code path should not throw regardless.
    const span = tracer.startSpan('test-span');
    const ctx = api.trace.setSpan(api.context.active(), span);

    let captured = '';
    const origWrite = process.stdout.write;
    process.stdout.write = function (chunk) { captured += chunk; };
    try {
      api.context.with(ctx, function () {
        log.info('traced message');
      });
    } finally {
      process.stdout.write = origWrite;
    }
    span.end();

    const entry = JSON.parse(captured);
    assert.strictEqual(entry.msg, 'traced message');
    // With no-op SDK, trace context may or may not be injected
    // (depends on whether traceId is non-zero). Either way, no error.
  });
});

describe('EU endpoint auto-detection', () => {
  it('should use EU endpoint for eu01xx license keys', () => {
    const result = execFileSync('node', ['-e', `
      process.env.NEW_RELIC_LICENSE_KEY = 'eu01xxFAKEKEY1234567890';
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      require("${tracingPath.replace(/\\/g, '\\\\')}");
    `], {
      env: { ...process.env, NEW_RELIC_LICENSE_KEY: 'eu01xxFAKEKEY1234567890', OTEL_EXPORTER_OTLP_ENDPOINT: '' },
      encoding: 'utf-8',
      timeout: 10000,
    });
    const lines = result.trim().split('\n');
    const startupLog = lines.find(l => l.includes('"OTel SDK started"'));
    assert.ok(startupLog, 'should log OTel SDK started');
    const parsed = JSON.parse(startupLog);
    assert.strictEqual(parsed.endpoint, 'https://otlp.eu01.nr-data.net');
  });

  it('should use US endpoint for non-EU license keys', () => {
    const result = execFileSync('node', ['-e', `
      process.env.NEW_RELIC_LICENSE_KEY = 'us01xxFAKEKEY1234567890';
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      require("${tracingPath.replace(/\\/g, '\\\\')}");
    `], {
      env: { ...process.env, NEW_RELIC_LICENSE_KEY: 'us01xxFAKEKEY1234567890', OTEL_EXPORTER_OTLP_ENDPOINT: '' },
      encoding: 'utf-8',
      timeout: 10000,
    });
    const lines = result.trim().split('\n');
    const startupLog = lines.find(l => l.includes('"OTel SDK started"'));
    assert.ok(startupLog, 'should log OTel SDK started');
    const parsed = JSON.parse(startupLog);
    assert.strictEqual(parsed.endpoint, 'https://otlp.nr-data.net');
  });

  it('should allow OTEL_EXPORTER_OTLP_ENDPOINT to override auto-detection', () => {
    const result = execFileSync('node', ['-e', `
      require("${tracingPath.replace(/\\/g, '\\\\')}");
    `], {
      env: { ...process.env, NEW_RELIC_LICENSE_KEY: 'eu01xxFAKEKEY1234567890', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://custom.endpoint.example' },
      encoding: 'utf-8',
      timeout: 10000,
    });
    const lines = result.trim().split('\n');
    const startupLog = lines.find(l => l.includes('"OTel SDK started"'));
    assert.ok(startupLog, 'should log OTel SDK started');
    const parsed = JSON.parse(startupLog);
    assert.strictEqual(parsed.endpoint, 'https://custom.endpoint.example');
  });
});

describe('nr-config module', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../server/lib/nr-config.js')];
  });

  it('should export load and store functions', () => {
    const nrConfig = require('../server/lib/nr-config.js');
    assert.strictEqual(typeof nrConfig.load, 'function');
    assert.strictEqual(typeof nrConfig.store, 'function');
  });

  it('should return error when S3 is not configured', (_, done) => {
    const env = { ...process.env };
    delete env.S3_ENDPOINT;
    delete env.S3_BUCKET;
    delete env.S3_ACCESS_KEY_ID;
    delete env.S3_SECRET_ACCESS_KEY;

    // Temporarily clear env
    const origEndpoint = process.env.S3_ENDPOINT;
    const origBucket = process.env.S3_BUCKET;
    const origKey = process.env.S3_ACCESS_KEY_ID;
    const origSecret = process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;

    const nrConfig = require('../server/lib/nr-config.js');
    nrConfig.load(function (err) {
      // Restore env
      if (origEndpoint) process.env.S3_ENDPOINT = origEndpoint;
      if (origBucket) process.env.S3_BUCKET = origBucket;
      if (origKey) process.env.S3_ACCESS_KEY_ID = origKey;
      if (origSecret) process.env.S3_SECRET_ACCESS_KEY = origSecret;

      assert.ok(err);
      assert.match(err.message, /S3 not configured/);
      done();
    });
  });
});
