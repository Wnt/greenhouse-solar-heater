const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const DEPLOY_SH = path.join(SCRIPTS_DIR, 'deploy.sh');
const CONF_PATH = path.join(SCRIPTS_DIR, 'devices.conf');

function runDeploy(ip, scriptId) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [DEPLOY_SH, ip, String(scriptId)], {
      cwd: SCRIPTS_DIR,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('deploy timed out\nstdout: ' + stdout + '\nstderr: ' + stderr));
    }, 15000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function createMockServer(handler) {
  const calls = [];
  let uploadedCode = '';

  const defaultHandler = (req, res, body) => {
    const url = req.url;
    if (url.includes('Script.Stop')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, was_running: true }));
    } else if (url.includes('Script.PutCode')) {
      const data = JSON.parse(body);
      if (!data.append) { uploadedCode = data.code; } else { uploadedCode += data.code; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ len: uploadedCode.length }));
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
    getUploadedCode: () => uploadedCode,
    resetUploadedCode: () => { uploadedCode = ''; },
  };
}

describe('deploy.sh', () => {
  let mock;
  let port;
  let originalConf;

  beforeEach(async () => {
    mock = createMockServer();
    await new Promise((resolve) => {
      mock.server.listen(0, '127.0.0.1', () => {
        port = mock.server.address().port;
        resolve();
      });
    });
    originalConf = fs.readFileSync(CONF_PATH, 'utf8');
    fs.writeFileSync(CONF_PATH,
      `PRO4PM=127.0.0.1:${port}\nPRO2PM_1=127.0.0.1\nSENSOR=127.0.0.1\n`
    );
  });

  afterEach(async () => {
    fs.writeFileSync(CONF_PATH, originalConf);
    await new Promise((resolve) => mock.server.close(resolve));
  });

  it('stops the script before uploading', async () => {
    const result = await runDeploy(`127.0.0.1:${port}`, 1);
    assert.strictEqual(result.code, 0, 'deploy should succeed: ' + result.stderr);

    const stopCalls = mock.calls.filter(c => c.url.includes('Script.Stop'));
    assert.strictEqual(stopCalls.length, 1, 'should call Script.Stop once');
    assert.ok(stopCalls[0].url.includes('id=1'), 'should stop script id 1');
  });

  it('uploads code in chunks with append flag', async () => {
    const result = await runDeploy(`127.0.0.1:${port}`, 1);
    assert.strictEqual(result.code, 0, 'deploy should succeed: ' + result.stderr);

    const putCalls = mock.calls.filter(c => c.url.includes('Script.PutCode'));
    assert.ok(putCalls.length > 1, `should upload in multiple chunks, got ${putCalls.length}`);

    // First chunk: append=false
    const first = JSON.parse(putCalls[0].body);
    assert.strictEqual(first.append, false, 'first chunk append should be false');
    assert.strictEqual(first.id, 1, 'script id should be 1');

    // Subsequent chunks: append=true
    for (let i = 1; i < putCalls.length; i++) {
      const chunk = JSON.parse(putCalls[i].body);
      assert.strictEqual(chunk.append, true, `chunk ${i + 1} append should be true`);
    }
  });

  it('uploads the full concatenated content of control-logic.js + control.js', async () => {
    const result = await runDeploy(`127.0.0.1:${port}`, 1);
    assert.strictEqual(result.code, 0, 'deploy should succeed: ' + result.stderr);

    const logicContent = fs.readFileSync(path.join(SCRIPTS_DIR, 'control-logic.js'), 'utf8');
    const controlContent = fs.readFileSync(path.join(SCRIPTS_DIR, 'control.js'), 'utf8');
    const expected = logicContent + '\n' + controlContent + '\n';

    assert.strictEqual(mock.getUploadedCode(), expected,
      'reassembled chunks should equal concatenated source files');
  });

  it('chunks are at most 512 bytes each', async () => {
    const result = await runDeploy(`127.0.0.1:${port}`, 1);
    assert.strictEqual(result.code, 0, 'deploy should succeed: ' + result.stderr);

    const putCalls = mock.calls.filter(c => c.url.includes('Script.PutCode'));
    for (let i = 0; i < putCalls.length; i++) {
      const chunk = JSON.parse(putCalls[i].body);
      assert.ok(chunk.code.length <= 512,
        `chunk ${i + 1} is ${chunk.code.length} bytes, should be <= 512`);
    }
  });

  it('enables auto-start after upload', async () => {
    const result = await runDeploy(`127.0.0.1:${port}`, 1);
    assert.strictEqual(result.code, 0, 'deploy should succeed: ' + result.stderr);

    const configCalls = mock.calls.filter(c => c.url.includes('Script.SetConfig'));
    assert.strictEqual(configCalls.length, 1, 'should call Script.SetConfig once');
    const configBody = JSON.parse(configCalls[0].body);
    assert.strictEqual(configBody.config.enable, true, 'should enable auto-start');
  });

  it('calls RPC endpoints in correct order: Stop, PutCode, SetConfig, Start', async () => {
    const result = await runDeploy(`127.0.0.1:${port}`, 1);
    assert.strictEqual(result.code, 0, 'deploy should succeed: ' + result.stderr);

    const stopIdx = mock.calls.findIndex(c => c.url.includes('Script.Stop'));
    const firstPutIdx = mock.calls.findIndex(c => c.url.includes('Script.PutCode'));
    const configIdx = mock.calls.findIndex(c => c.url.includes('Script.SetConfig'));
    const startIdx = mock.calls.findIndex(c => c.url.includes('Script.Start'));

    assert.ok(stopIdx >= 0, 'should call Script.Stop');
    assert.ok(firstPutIdx >= 0, 'should call Script.PutCode');
    assert.ok(configIdx >= 0, 'should call Script.SetConfig');
    assert.ok(startIdx >= 0, 'should call Script.Start');

    assert.ok(stopIdx < firstPutIdx, 'Stop should come before PutCode');
    assert.ok(firstPutIdx < configIdx, 'PutCode should come before SetConfig');
    assert.ok(configIdx < startIdx, 'SetConfig should come before Start');
  });

  it('uses the provided script ID', async () => {
    const result = await runDeploy(`127.0.0.1:${port}`, 3);
    assert.strictEqual(result.code, 0, 'deploy should succeed: ' + result.stderr);

    const putCalls = mock.calls.filter(c => c.url.includes('Script.PutCode'));
    for (const call of putCalls) {
      const body = JSON.parse(call.body);
      assert.strictEqual(body.id, 3, 'should use script id 3');
    }
  });

  it('fails on PutCode HTTP error', async () => {
    // Replace mock with one that errors on PutCode
    await new Promise((resolve) => mock.server.close(resolve));

    mock = createMockServer((req, res, body) => {
      if (req.url.includes('Script.Stop')) {
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
      mock.server.listen(port, '127.0.0.1', resolve);
    });

    const result = await runDeploy(`127.0.0.1:${port}`, 1);
    assert.ok(result.code !== 0, 'should exit with non-zero status');
    assert.ok(result.stdout.includes('ERROR'), 'should print error message');
  });
});
