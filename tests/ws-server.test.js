const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const { WebSocketServer, _encodeFrame, _acceptKey } = require('../server/lib/ws-server.js');

describe('ws-server handshake', () => {
  it('computes Sec-WebSocket-Accept per RFC 6455 §1.3', () => {
    // Reference example from RFC 6455 §1.3
    assert.strictEqual(
      _acceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
      's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
    );
  });

  it('encodes short text frames with FIN=1, opcode=1, no mask', () => {
    const f = _encodeFrame(0x1, 'hi');
    assert.strictEqual(f[0], 0x81);  // FIN | text
    assert.strictEqual(f[1], 2);     // payload length, MASK=0
    assert.strictEqual(f.slice(2).toString('utf8'), 'hi');
  });

  it('encodes 16-bit length frames (126…65535)', () => {
    const big = Buffer.alloc(200, 'a');
    const f = _encodeFrame(0x1, big);
    assert.strictEqual(f[0], 0x81);
    assert.strictEqual(f[1], 126);
    assert.strictEqual(f.readUInt16BE(2), 200);
    assert.strictEqual(f.length, 4 + 200);
  });

  it('encodes 64-bit length frames (>65535)', () => {
    const huge = Buffer.alloc(70000, 'b');
    const f = _encodeFrame(0x1, huge);
    assert.strictEqual(f[0], 0x81);
    assert.strictEqual(f[1], 127);
    assert.strictEqual(Number(f.readBigUInt64BE(2)), 70000);
    assert.strictEqual(f.length, 10 + 70000);
  });
});

// Helper: build a masked client frame (text, FIN=1).
function maskedClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    throw new Error('helper too small');
  }
  header[0] = 0x81;  // FIN | text
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

describe('ws-server live round-trip', () => {
  function startServer() {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ noServer: true });
      const server = http.createServer();
      server.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        resolve({ server, wss, port });
      });
    });
  }

  // Tear down the server *and* every upgraded WebSocket socket. After
  // handleUpgrade() the http server detaches the socket, so server.close()
  // and closeAllConnections() do not reach upgraded connections — without
  // this, lingering sockets keep node:test's event loop alive and the
  // process never exits.
  function closeServer({ server, wss }) {
    if (wss) {
      wss.clients.forEach((c) => { try { c.terminate(); } catch (_) { /* ignore */ } });
      wss.clients.clear();
    }
    server.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.unref();
  }

  function rawHandshake(port) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      const key = crypto.randomBytes(16).toString('base64');
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd >= 0) {
          const headerStr = buf.slice(0, headerEnd).toString('utf8');
          resolve({ sock, headerStr, leftover: buf.slice(headerEnd + 4), key });
        }
      });
      sock.on('error', reject);
      sock.write(
        'GET /ws HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      );
    });
  }

  it('completes the upgrade handshake with correct Sec-WebSocket-Accept', async () => {
    const { server, wss, port } = await startServer();
    try {
      const { sock, headerStr, key } = await rawHandshake(port);
      assert.match(headerStr, /^HTTP\/1\.1 101 /);
      const expected = _acceptKey(key);
      // Plain substring check — `expected` is base64 (`A-Za-z0-9+/=`) and
      // would otherwise need every regex metachar escaped.
      assert.ok(
        headerStr.includes('Sec-WebSocket-Accept: ' + expected),
        'response missing expected Sec-WebSocket-Accept header'
      );
      sock.destroy();
    } finally {
      closeServer({ server, wss });
      
    }
  });

  it('receives masked client text frames as Buffer messages', async () => {
    const { server, wss, port } = await startServer();
    try {
      const received = [];
      wss.on('connection', (ws) => {
        ws.on('message', (m) => received.push(m.toString('utf8')));
      });
      const { sock } = await rawHandshake(port);
      sock.write(maskedClientFrame('hello'));
      sock.write(maskedClientFrame('world'));
      await new Promise((r) => setTimeout(r, 30));
      assert.deepStrictEqual(received, ['hello', 'world']);
      sock.destroy();
    } finally {
      closeServer({ server, wss });
      
    }
  });

  it('sends server frames the client can decode (unmasked)', async () => {
    const { server, wss, port } = await startServer();
    try {
      let connectedWs = null;
      wss.on('connection', (ws) => { connectedWs = ws; });
      const { sock } = await rawHandshake(port);
      await new Promise((r) => setTimeout(r, 10));
      const collected = [];
      sock.on('data', (c) => collected.push(c));
      connectedWs.send('greetings');
      await new Promise((r) => setTimeout(r, 30));
      const buf = Buffer.concat(collected);
      assert.strictEqual(buf[0], 0x81);
      assert.strictEqual(buf[1], 9);  // unmasked text, len 9
      assert.strictEqual(buf.slice(2, 11).toString('utf8'), 'greetings');
      sock.destroy();
    } finally {
      closeServer({ server, wss });
      
    }
  });

  it('responds to ping with pong containing same payload', async () => {
    const { server, wss, port } = await startServer();
    try {
      const { sock } = await rawHandshake(port);
      const pingPayload = Buffer.from('ping-data', 'utf8');
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(pingPayload.length);
      for (let i = 0; i < masked.length; i++) masked[i] = pingPayload[i] ^ mask[i % 4];
      const frame = Buffer.concat([
        Buffer.from([0x89, 0x80 | masked.length]),  // FIN | ping, MASK | len
        mask,
        masked,
      ]);
      const collected = [];
      sock.on('data', (c) => collected.push(c));
      sock.write(frame);
      await new Promise((r) => setTimeout(r, 30));
      const buf = Buffer.concat(collected);
      assert.strictEqual(buf[0], 0x8a);  // FIN | pong
      assert.strictEqual(buf[1], pingPayload.length);
      assert.strictEqual(buf.slice(2, 2 + pingPayload.length).toString('utf8'), 'ping-data');
      sock.destroy();
    } finally {
      closeServer({ server, wss });
      
    }
  });

  it('clients set tracks open connections; cleared on close', async () => {
    const { server, wss, port } = await startServer();
    try {
      const { sock: s1 } = await rawHandshake(port);
      const { sock: s2 } = await rawHandshake(port);
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(wss.clients.size, 2);
      s1.destroy();
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(wss.clients.size, 1);
      s2.destroy();
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(wss.clients.size, 0);
    } finally {
      closeServer({ server, wss });
      
    }
  });

  it('readyState is 1 (OPEN) for connected clients', async () => {
    const { server, wss, port } = await startServer();
    try {
      let connectedWs = null;
      wss.on('connection', (ws) => { connectedWs = ws; });
      const { sock } = await rawHandshake(port);
      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(connectedWs.readyState, 1);
      sock.destroy();
    } finally {
      closeServer({ server, wss });
      
    }
  });

  it('rejects upgrade missing Sec-WebSocket-Key', async () => {
    const { server, wss, port } = await startServer();
    try {
      const sock = net.connect(port, '127.0.0.1');
      let buf = Buffer.alloc(0);
      const ended = new Promise((r) => sock.on('close', r));
      sock.on('data', (c) => { buf = Buffer.concat([buf, c]); });
      sock.write(
        'GET /ws HTTP/1.1\r\n' +
        'Host: 127.0.0.1\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n'
      );
      await ended;
      assert.match(buf.toString('utf8'), /^HTTP\/1\.1 400 /);
    } finally {
      closeServer({ server, wss });
      
    }
  });
});
