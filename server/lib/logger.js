/**
 * Structured JSON logger (FR-013).
 *
 * Usage:
 *   const log = require('./lib/logger')('auth');
 *   log.info('user logged in', { userId: '...' });
 *
 * Output (one JSON object per line):
 *   {"ts":"2026-03-20T12:00:00.000Z","level":"info","component":"auth","msg":"user logged in","userId":"..."}
 */

const otelApi = require('@opentelemetry/api');
const otelLogs = require('@opentelemetry/api-logs');

const SEVERITY_MAP = {
  info: otelLogs.SeverityNumber.INFO,
  warn: otelLogs.SeverityNumber.WARN,
  error: otelLogs.SeverityNumber.ERROR,
};

function createLogger(component) {
  function write(level, msg, data) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
    };
    // Inject OTel trace context for log correlation (no-op when SDK not initialized)
    const spanContext = otelApi.trace.getSpan(otelApi.context.active());
    if (spanContext) {
      const ctx = spanContext.spanContext();
      if (ctx && ctx.traceId) {
        entry['trace.id'] = ctx.traceId;
        entry['span.id'] = ctx.spanId;
      }
    }
    if (data) {
      const keys = Object.keys(data);
      for (let i = 0; i < keys.length; i++) {
        entry[keys[i]] = data[keys[i]];
      }
    }
    const out = level === 'error' ? process.stderr : process.stdout;
    out.write(JSON.stringify(entry) + '\n');

    // Emit OTel log record (no-op when SDK not initialized)
    const otelLogger = otelLogs.logs.getLogger(component);
    const attributes = { component, level };
    if (data) {
      const dataKeys = Object.keys(data);
      for (let j = 0; j < dataKeys.length; j++) {
        attributes[dataKeys[j]] = data[dataKeys[j]];
      }
    }
    otelLogger.emit({
      severityNumber: SEVERITY_MAP[level] || otelLogs.SeverityNumber.INFO,
      severityText: level.toUpperCase(),
      body: msg,
      attributes,
    });
  }

  return {
    info: function (msg, data) { write('info', msg, data); },
    warn: function (msg, data) { write('warn', msg, data); },
    error: function (msg, data) { write('error', msg, data); },
  };
}

module.exports = createLogger;
