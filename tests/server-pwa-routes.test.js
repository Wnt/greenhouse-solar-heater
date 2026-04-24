/**
 * Integration test: PWA static assets must be accessible WITHOUT a
 * session cookie when AUTH_ENABLED=true.
 *
 * Chrome fetches <link rel="manifest"> and icons with credentials=omit
 * by default, so if these paths are gated behind the login redirect
 * the browser gets 302→login.html, parses the HTML as JSON, and
 * installability fails silently.
 *
 * This test starts the real server.js as a subprocess with
 * AUTH_ENABLED=true and asserts:
 *   - /sw.js, /manifest.webmanifest, /assets/icon-*.png return 200
 *     with correct content-type (no redirect)
 *   - Protected paths (/, /api/device-config PUT) still redirect/401
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3299;

function request(pathname, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForServerReady(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for server to start'));
    }, timeoutMs);

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (buffer.indexOf('"server started"') !== -1) {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
}

describe('server PWA public routes (AUTH_ENABLED=true)', () => {
  let serverProc;
  let tmpDir;
  let credsPath;
  let pushConfigPath;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-pwa-test-'));
    credsPath = path.join(tmpDir, 'credentials.json');
    pushConfigPath = path.join(tmpDir, 'push-config.json');

    const serverPath = path.resolve(__dirname, '..', 'server', 'server.js');
    serverProc = spawn('node', [serverPath], {
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        AUTH_ENABLED: 'true',
        SESSION_SECRET: 'test-session-secret-for-testing-purposes-only-32chars',
        RPID: 'localhost',
        ORIGIN: 'http://localhost:' + PORT,
        S3_ENDPOINT: '',
        S3_BUCKET: '',
        S3_ACCESS_KEY_ID: '',
        S3_SECRET_ACCESS_KEY: '',
        DATABASE_URL: '',
        MQTT_HOST: '',
        CREDENTIALS_PATH: credsPath,
        PUSH_CONFIG_PATH: pushConfigPath,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await waitForServerReady(serverProc, 10000);
    // One extra tick to let listen() finish
    await new Promise((r) => setTimeout(r, 100));
  });

  after(() => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  });

  describe('Unauthenticated requests to PWA assets succeed', () => {
    it('GET /sw.js → 200 with application/javascript', async () => {
      const res = await request('/sw.js');
      assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
      assert.match(res.headers['content-type'] || '', /javascript/);
      assert.match(res.body, /addEventListener\s*\(\s*['"]fetch['"]/);
    });

    it('GET /manifest.webmanifest → 200 with manifest+json', async () => {
      const res = await request('/manifest.webmanifest');
      assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
      assert.match(res.headers['content-type'] || '', /manifest\+json|application\/json/);
      const manifest = JSON.parse(res.body);
      assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
      assert.strictEqual(manifest.display, 'standalone');
    });

    it('GET /assets/icon-192.png → 200 with image/png', async () => {
      const res = await request('/assets/icon-192.png');
      assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
      assert.match(res.headers['content-type'] || '', /image\/png/);
    });

    it('GET /assets/icon-512.png → 200', async () => {
      const res = await request('/assets/icon-512.png');
      assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
    });

    it('GET /assets/icon-512-maskable.png → 200', async () => {
      const res = await request('/assets/icon-512-maskable.png');
      assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
    });

    it('GET /assets/badge-72.png → 200 (Android status-bar silhouette)', async () => {
      const res = await request('/assets/badge-72.png');
      assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
      assert.match(res.headers['content-type'] || '', /image\/png/);
    });

    it('each per-category notification icon is served as PNG', async () => {
      const slugs = ['evening', 'noon', 'overheat', 'freeze', 'offline'];
      for (const slug of slugs) {
        const res = await request('/assets/notif-' + slug + '.png');
        assert.strictEqual(res.status, 200, 'expected 200 for notif-' + slug + '.png, got ' + res.status);
        assert.match(res.headers['content-type'] || '', /image\/png/);
      }
    });
  });

  describe('Login page assets are public under /public/', () => {
    it('GET /public/login.html → 200', async () => {
      const res = await request('/public/login.html');
      assert.strictEqual(res.status, 200);
      assert.match(res.body, /Helios Canopy/);
    });

    it('login.html references the current manifest and icon paths', async () => {
      const res = await request('/public/login.html');
      assert.match(res.body, /manifest\.webmanifest/, 'login.html must link the current manifest');
      assert.match(res.body, /assets\/icon-192\.png/, 'login.html must use the current icon path');
      assert.doesNotMatch(res.body, /manifest\.json/, 'login.html must not reference the old manifest.json path');
      assert.doesNotMatch(res.body, /icons\/icon-/, 'login.html must not reference the old /icons/ path');
    });

    it('login.html theme-color is the Stitch dark value', async () => {
      const res = await request('/public/login.html');
      assert.match(res.body, /theme-color" content="#0c0e12"/);
    });

    it('GET /public/style.css → 200 with CSS body (not the login HTML)', async () => {
      const res = await request('/public/style.css');
      assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
      assert.match(res.headers['content-type'] || '', /text\/css/);
      assert.match(res.body, /--primary:\s*#e9c349/);
      assert.doesNotMatch(res.body, /<!DOCTYPE html>/);
    });

    it('GET /public/material-symbols.css → 200 with CSS body', async () => {
      const res = await request('/public/material-symbols.css');
      assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
      assert.match(res.headers['content-type'] || '', /text\/css/);
      assert.match(res.body, /@font-face/);
    });

    it('GET /public/material-symbols-outlined.woff2 → 200 with woff2', async () => {
      const res = await request('/public/material-symbols-outlined.woff2');
      assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
      assert.match(res.headers['content-type'] || '', /font\/woff2|application\/octet-stream/);
    });

    it('GET /public/login.js → 200 with JS body', async () => {
      const res = await request('/public/login.js');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'] || '', /javascript/);
    });

    it('GET /public/simplewebauthn-browser.mjs → 200 with JS body', async () => {
      const res = await request('/public/simplewebauthn-browser.mjs');
      assert.strictEqual(res.status, 200);
      assert.match(res.headers['content-type'] || '', /javascript/);
    });
  });

  describe('Protected routes still require auth', () => {
    it('GET / → 302 redirect to /public/login.html', async () => {
      const res = await request('/');
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/public/login.html');
    });

    it('GET /index.html → 302 redirect to /public/login.html', async () => {
      const res = await request('/index.html');
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/public/login.html');
    });

    it('GET /login.html (old path) → 302 redirect (no longer served)', async () => {
      const res = await request('/login.html');
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/public/login.html');
    });

    it('GET /api/history → 401 JSON error', async () => {
      const res = await request('/api/history');
      assert.strictEqual(res.status, 401);
      const body = JSON.parse(res.body);
      assert.ok(body.error);
    });

    it('POST /api/push/test without session → 401', async () => {
      const res = await request('/api/push/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.strictEqual(res.status, 401);
    });
  });
});
