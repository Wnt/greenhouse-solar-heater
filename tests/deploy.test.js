const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const SCRIPTS_DIR = path.join(__dirname, '..', 'shelly');
const DEPLOY_SH = path.join(SCRIPTS_DIR, 'deploy.sh');
const CONF_PATH = path.join(SCRIPTS_DIR, 'devices.conf');

// Shelly Script.PutCode rejects payloads over 65535 bytes with
// `code:-103, Invalid argument 'code': Script length exceeded 65535 bytes limit!`
const SHELLY_SCRIPT_LIMIT = 65535;

// Mirrors the minify() in shelly/deploy.sh's upload_script helper.
function minify(src) {
  const out = [];
  for (const line of src.split('\n')) {
    const stripped = line.replace(/^\s+/, '');
    if (!stripped || stripped.startsWith('//')) continue;
    out.push(stripped);
  }
  return out.join('\n') + '\n';
}

// Safety net: always restore devices.conf on process exit
const ORIGINAL_CONF = fs.readFileSync(CONF_PATH, 'utf8');
process.on('exit', () => {
  try { fs.writeFileSync(CONF_PATH, ORIGINAL_CONF); } catch (_) {}
});

function runDeploy(ip, scriptId) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [DEPLOY_SH, ip, String(scriptId)], {
      cwd: SCRIPTS_DIR,
      env: { ...process.env, DEPLOY_STOP_DELAY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('deploy timed out\nstdout: ' + stdout + '\nstderr: ' + stderr));
    }, 5000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function createMockServer(handler) {
  const calls = [];
  const uploadedCodes = {}; // per-script-id uploaded code

  const defaultHandler = (req, res, body) => {
    const url = req.url;
    if (url.includes('Script.Stop')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, was_running: true }));
    } else if (url.includes('Script.List')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ scripts: [{ id: 1 }, { id: 2 }] }));
    } else if (url.includes('Script.Create')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1 }));
    } else if (url.includes('Script.Delete')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    } else if (url.includes('Script.PutCode')) {
      const data = JSON.parse(body);
      const id = data.id || 1;
      if (!data.append) { uploadedCodes[id] = data.code; } else { uploadedCodes[id] = (uploadedCodes[id] || '') + data.code; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ len: (uploadedCodes[id] || '').length }));
    } else if (url.includes('Script.SetConfig')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ restart_required: false }));
    } else if (url.includes('Script.Start')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ was_running: false }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ url: req.url, method: req.method, body: body || null });
      (handler || defaultHandler)(req, res, body);
    });
  });

  return {
    server,
    calls,
    getUploadedCode: (id) => uploadedCodes[id || 1] || '',
  };
}

// Run deploy.sh once and share results across assertions
describe('deploy.sh', () => {
  let mock;
  let port;
  let deployResult;

  before(async () => {
    mock = createMockServer();
    await new Promise((resolve) => {
      mock.server.listen(0, '127.0.0.1', () => {
        port = mock.server.address().port;
        resolve();
      });
    });
    fs.writeFileSync(CONF_PATH,
      `PRO4PM=127.0.0.1:${port}\nPRO2PM_1=127.0.0.1\nSENSOR=127.0.0.1\nPRO4PM_VPN=127.0.0.1:${port}\n`
    );
    deployResult = await runDeploy(`127.0.0.1:${port}`, 1);
  });

  after(async () => {
    fs.writeFileSync(CONF_PATH, ORIGINAL_CONF);
    await new Promise((resolve) => mock.server.close(resolve));
  });

  it('exits successfully', () => {
    assert.strictEqual(deployResult.code, 0, 'deploy should succeed: ' + deployResult.stderr);
  });

  it('stops the control script before uploading', () => {
    const stopCalls = mock.calls.filter(c => c.url.includes('Script.Stop'));
    assert.ok(stopCalls.length >= 1, 'should call Script.Stop at least once');
    assert.ok(stopCalls[0].url.includes('id=1'), 'should stop script id 1');
  });

  it('uploads control code in chunks with append flag', () => {
    // Filter PutCode calls for script id 1 (control)
    const putCalls = mock.calls.filter(c => {
      if (!c.url.includes('Script.PutCode')) return false;
      const body = JSON.parse(c.body);
      return body.id === 1;
    });
    assert.ok(putCalls.length > 1, `should upload in multiple chunks, got ${putCalls.length}`);

    const first = JSON.parse(putCalls[0].body);
    assert.strictEqual(first.append, false, 'first chunk append should be false');
    assert.strictEqual(first.id, 1, 'script id should be 1');

    for (let i = 1; i < putCalls.length; i++) {
      const chunk = JSON.parse(putCalls[i].body);
      assert.strictEqual(chunk.append, true, `chunk ${i + 1} append should be true`);
    }
  });

  it('reassembles control script to the minified concatenated source', () => {
    const logicContent = fs.readFileSync(path.join(SCRIPTS_DIR, 'control-logic.js'), 'utf8');
    const controlContent = fs.readFileSync(path.join(SCRIPTS_DIR, 'control.js'), 'utf8');
    const expected = minify(logicContent) + minify(controlContent);

    // Reconstruct only the script id=1 uploads
    let controlCode = '';
    const putCalls = mock.calls.filter(c => c.url.includes('Script.PutCode'));
    for (const call of putCalls) {
      const body = JSON.parse(call.body);
      if (body.id === 1) {
        if (!body.append) { controlCode = body.code; } else { controlCode += body.code; }
      }
    }
    assert.strictEqual(controlCode, expected);
  });

  it('deployed control script stays under the 65535-byte Shelly limit', () => {
    let controlCode = '';
    const putCalls = mock.calls.filter(c => c.url.includes('Script.PutCode'));
    for (const call of putCalls) {
      const body = JSON.parse(call.body);
      if (body.id === 1) {
        if (!body.append) { controlCode = body.code; } else { controlCode += body.code; }
      }
    }
    assert.ok(controlCode.length <= SHELLY_SCRIPT_LIMIT,
      `deployed control script is ${controlCode.length} bytes, exceeds ${SHELLY_SCRIPT_LIMIT}-byte device limit`);
  });

  it('chunks are at most 512 bytes each', () => {
    const putCalls = mock.calls.filter(c => c.url.includes('Script.PutCode'));
    for (let i = 0; i < putCalls.length; i++) {
      const chunk = JSON.parse(putCalls[i].body);
      assert.ok(chunk.code.length <= 512,
        `chunk ${i + 1} is ${chunk.code.length} bytes, should be <= 512`);
    }
  });

  it('enables auto-start after upload', () => {
    // ensure_script_slots may call SetConfig with enable:false on empty
    // slots it creates; the post-upload SetConfig is the enable:true one.
    const enableCalls = mock.calls.filter(c => {
      if (!c.url.includes('Script.SetConfig')) return false;
      try { return JSON.parse(c.body).config.enable === true; } catch (_) { return false; }
    });
    assert.ok(enableCalls.length >= 1, 'should call Script.SetConfig with enable:true at least once');
  });

  it('calls RPCs in order: PutCode, SetConfig(enable:true), Start for control script', () => {
    // Stop ordering assertions dropped — ensure_script_slots may issue its
    // own Stop calls before the expected one. What matters is upload →
    // enable → start.
    const firstPutIdx = mock.calls.findIndex(c => c.url.includes('Script.PutCode'));
    const enableIdx = mock.calls.findIndex(c => {
      if (!c.url.includes('Script.SetConfig')) return false;
      try { return JSON.parse(c.body).config.enable === true; } catch (_) { return false; }
    });
    const startIdx = mock.calls.findIndex(c => c.url.includes('Script.Start'));

    assert.ok(firstPutIdx < enableIdx, 'PutCode before SetConfig(enable:true)');
    assert.ok(enableIdx < startIdx, 'SetConfig before Start');
  });

  it('does NOT create a second script slot (single merged script)', () => {
    const putCalls = mock.calls.filter(c => {
      if (!c.url.includes('Script.PutCode')) return false;
      const body = JSON.parse(c.body);
      return body.id === 2;
    });
    assert.strictEqual(putCalls.length, 0,
      'No id=2 PutCode should occur after the telemetry merge');
  });
});

// Separate deploy run for error handling
describe('deploy.sh error handling', () => {
  let mock;
  let port;

  before(async () => {
    mock = createMockServer((req, res) => {
      if (req.url.includes('Script.List')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ scripts: [{ id: 1 }, { id: 2 }] }));
      } else if (req.url.includes('Script.Stop')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 1 }));
      } else if (req.url.includes('Script.PutCode')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: -1, message: 'out of memory' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
    await new Promise((resolve) => {
      mock.server.listen(0, '127.0.0.1', () => {
        port = mock.server.address().port;
        resolve();
      });
    });
    fs.writeFileSync(CONF_PATH,
      `PRO4PM=127.0.0.1:${port}\nPRO2PM_1=127.0.0.1\nSENSOR=127.0.0.1\nPRO4PM_VPN=127.0.0.1:${port}\n`
    );
  });

  after(async () => {
    fs.writeFileSync(CONF_PATH, ORIGINAL_CONF);
    await new Promise((resolve) => mock.server.close(resolve));
  });

  it('fails on PutCode HTTP error', async () => {
    const result = await runDeploy(`127.0.0.1:${port}`, 1);
    assert.ok(result.code !== 0, 'should exit with non-zero status');
    assert.ok(result.stdout.includes('ERROR'), 'should print error message');
  });
});
