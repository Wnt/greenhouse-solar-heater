'use strict';

// Drops server-side log lines that originate from pg-mem's known
// inability to parse the production UNION ALL/ORDER BY history query.
//
// The e2e harness (tests/e2e/_setup/start.cjs) uses pg-mem in place of
// PostgreSQL/TimescaleDB. pg-mem rejects the parenthesised
// `(SELECT …) UNION ALL (SELECT …) ORDER BY ts` shape that
// server/lib/db.js builds for ≤48h history ranges with
// "💀 Syntax error … Unexpected kw_order token". The harness already
// accepts that /api/history returns 500 in that case (see
// tests/e2e/health-smoke.spec.js); what we don't want is the server's
// downstream `log.error('history query failed', …)` JSON entry
// surfacing as `[WebServer]` noise on every page render.
//
// The filter is intentionally narrow — only lines that match
// component=http, msg='history query failed', AND contain pg-mem's
// `Unexpected kw_order` signature are dropped. Unrelated errors
// (including unrelated pg-mem failures and unrelated http errors)
// still print.

function shouldSuppress(line) {
  return typeof line === 'string'
    && line.indexOf('"component":"http"') !== -1
    && line.indexOf('"msg":"history query failed"') !== -1
    && line.indexOf('Unexpected kw_order') !== -1;
}

function install(stream) {
  const target = stream || process.stderr;
  const orig = target.write.bind(target);
  target.write = function (chunk, encoding, cb) {
    const str = typeof chunk === 'string' ? chunk : (chunk && chunk.toString());
    if (shouldSuppress(str)) {
      const done = typeof encoding === 'function' ? encoding
        : typeof cb === 'function' ? cb
        : null;
      if (done) done();
      return true;
    }
    return orig(chunk, encoding, cb);
  };
  return function uninstall() { target.write = orig; };
}

module.exports = { install, shouldSuppress };
