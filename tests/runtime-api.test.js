/**
 * /api/runtime exposes deploy-time runtime metadata so the frontend (and
 * the unauthenticated login page) can rebrand themselves on PR previews.
 *
 *   { preview: null }                                  // prod / local dev
 *   { preview: { pr: 42, branch: 'feature/foo' } }     // PR preview
 *   { preview: { pr: 42, branch: null } }              // BRANCH_NAME unset
 *
 * The endpoint is public — it's reached pre-auth so login.html can
 * fetch it. No PII; only the deploy's PR number + git ref.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createHandlers } = require('../server/lib/http-handlers');

function startTestServer(envOverrides) {
  const prevEnv = {};
  Object.keys(envOverrides).forEach((k) => {
    prevEnv[k] = process.env[k];
    if (envOverrides[k] === undefined) delete process.env[k];
    else process.env[k] = envOverrides[k];
  });

  // Re-require http-handlers so the module-scope env reads pick up the
  // overrides. Drop createHandlers's cached reference along with it.
  delete require.cache[require.resolve('../server/lib/http-handlers')];
  const { createHandlers: freshCreateHandlers } = require('../server/lib/http-handlers');
  const handlers = freshCreateHandlers({
    db: null,
    authMiddleware: null,
    broadcastToWebSockets: () => {},
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/api/runtime') return handlers.handleRuntimeApi(req, res);
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((r) => {
          // restore env
          Object.keys(prevEnv).forEach((k) => {
            if (prevEnv[k] === undefined) delete process.env[k];
            else process.env[k] = prevEnv[k];
          });
          server.close(() => r());
        }),
      });
    });
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

describe('/api/runtime', () => {
  it('returns preview: null when PREVIEW_MODE is unset', async () => {
    const srv = await startTestServer({ PREVIEW_MODE: undefined, PR_NUMBER: undefined, BRANCH_NAME: undefined });
    try {
      const r = await get(srv.port, '/api/runtime');
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.preview, null);
    } finally { await srv.close(); }
  });

  it('returns preview.pr + preview.branch in PREVIEW_MODE', async () => {
    const srv = await startTestServer({ PREVIEW_MODE: 'true', PR_NUMBER: '42', BRANCH_NAME: 'feature/foo' });
    try {
      const r = await get(srv.port, '/api/runtime');
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.deepEqual(body.preview, { pr: 42, branch: 'feature/foo' });
    } finally { await srv.close(); }
  });

  it('preview.branch is null when BRANCH_NAME is unset but PREVIEW_MODE is true', async () => {
    const srv = await startTestServer({ PREVIEW_MODE: 'true', PR_NUMBER: '7', BRANCH_NAME: undefined });
    try {
      const r = await get(srv.port, '/api/runtime');
      const body = JSON.parse(r.body);
      assert.deepEqual(body.preview, { pr: 7, branch: null });
    } finally { await srv.close(); }
  });

  it('preview.pr is null when PR_NUMBER is missing or non-numeric', async () => {
    // Defensive — envsubst should always provide PR_NUMBER on a real
    // preview pod, but we don't want a non-numeric leak to crash the
    // frontend's `Preview #${pr}` template literal.
    const srv = await startTestServer({ PREVIEW_MODE: 'true', PR_NUMBER: 'oops', BRANCH_NAME: 'main' });
    try {
      const r = await get(srv.port, '/api/runtime');
      const body = JSON.parse(r.body);
      assert.equal(body.preview.pr, null);
      assert.equal(body.preview.branch, 'main');
    } finally { await srv.close(); }
  });
});
