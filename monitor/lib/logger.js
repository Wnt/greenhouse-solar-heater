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

var otelApi = require('@opentelemetry/api');

function createLogger(component) {
  function write(level, msg, data) {
    var entry = {
      ts: new Date().toISOString(),
      level: level,
      component: component,
      msg: msg,
    };
    // Inject OTel trace context for log correlation (no-op when SDK not initialized)
    var spanContext = otelApi.trace.getSpan(otelApi.context.active());
    if (spanContext) {
      var ctx = spanContext.spanContext();
      if (ctx && ctx.traceId) {
        entry['trace.id'] = ctx.traceId;
        entry['span.id'] = ctx.spanId;
      }
    }
    if (data) {
      var keys = Object.keys(data);
      for (var i = 0; i < keys.length; i++) {
        entry[keys[i]] = data[keys[i]];
      }
    }
    var out = level === 'error' ? process.stderr : process.stdout;
    out.write(JSON.stringify(entry) + '\n');
  }

  return {
    info: function (msg, data) { write('info', msg, data); },
    warn: function (msg, data) { write('warn', msg, data); },
    error: function (msg, data) { write('error', msg, data); },
  };
}

module.exports = createLogger;
