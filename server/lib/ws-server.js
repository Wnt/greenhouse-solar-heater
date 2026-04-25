/**
 * Minimal RFC 6455 WebSocket server (no-server mode only).
 *
 * Drop-in shape (subset of `ws@8`):
 *   const { WebSocketServer } = require('./ws-server');
 *   const wss = new WebSocketServer({ noServer: true });
 *   server.on('upgrade', (req, socket, head) => {
 *     wss.handleUpgrade(req, socket, head, (ws) => {
 *       wss.emit('connection', ws, req);
 *       ws.send('hello');
 *       ws.on('message', (data) => { ... });
 *     });
 *   });
 *   wss.clients.forEach(ws => ws.send('...'));  // ws.readyState === 1
 *
 * Supports text/binary frames, ping/pong, close. No extensions
 * (no permessage-deflate) and no fragmentation outbound — adequate for
 * our small JSON messages.
 */

'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const STATE_CONNECTING = 0;
const STATE_OPEN = 1;
const STATE_CLOSING = 2;
const STATE_CLOSED = 3;

function acceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + GUID).digest('base64');
}

// ── Frame encoder (server → client, no mask) ────────────────────────────────

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;        // FIN=1
    header[1] = len;                  // MASK=0, len
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

// ── WebSocket connection ────────────────────────────────────────────────────

class WebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this._socket = socket;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this.readyState = STATE_OPEN;
    this._role = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onSocketClose());
    // Half-close from peer: tear down our side too.
    socket.on('end', () => { try { socket.end(); } catch (e) { /* ignore */ } });
    // Swallow socket errors so they don't bubble as uncaught exceptions
    // when no consumer is listening — 'close' will follow.
    socket.on('error', () => { /* ignore; close will follow */ });
  }

  send(data) {
    if (this.readyState !== STATE_OPEN) return;
    const opcode = Buffer.isBuffer(data) ? OP_BINARY : OP_TEXT;
    try {
      this._socket.write(encodeFrame(opcode, data));
    } catch (e) {
      // Socket already torn down — readyState will catch up via 'close'.
    }
  }

  ping(data) {
    if (this.readyState !== STATE_OPEN) return;
    try { this._socket.write(encodeFrame(OP_PING, data || Buffer.alloc(0))); }
    catch (e) { /* ignore */ }
  }

  close(code, reason) {
    if (this.readyState >= STATE_CLOSING) return;
    this.readyState = STATE_CLOSING;
    let payload = Buffer.alloc(0);
    if (typeof code === 'number') {
      const reasonBuf = reason ? Buffer.from(String(reason), 'utf8') : Buffer.alloc(0);
      payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
    }
    try { this._socket.write(encodeFrame(OP_CLOSE, payload)); }
    catch (e) { /* ignore */ }
    this._socket.end();
  }

  terminate() {
    this.readyState = STATE_CLOSED;
    try { this._socket.destroy(); } catch (e) { /* ignore */ }
  }

  _onSocketClose() {
    if (this.readyState === STATE_CLOSED) return;
    this.readyState = STATE_CLOSED;
    this.emit('close');
  }

  _onData(chunk) {
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    while (this._tryParseFrame()) { /* keep parsing while frames complete */ }
  }

  // Returns true if a frame was consumed from the buffer.
  _tryParseFrame() {
    if (this._buf.length < 2) return false;

    const b0 = this._buf[0];
    const b1 = this._buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (this._buf.length < offset + 2) return false;
      payloadLen = this._buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (this._buf.length < offset + 8) return false;
      const big = this._buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this._failConnection(1009, 'Frame too large');
        return false;
      }
      payloadLen = Number(big);
      offset += 8;
    }

    // Per RFC 6455 §5.1, client→server frames MUST be masked.
    if (!masked) {
      this._failConnection(1002, 'Unmasked client frame');
      return false;
    }

    if (this._buf.length < offset + 4) return false;
    const maskKey = this._buf.slice(offset, offset + 4);
    offset += 4;

    if (this._buf.length < offset + payloadLen) return false;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = this._buf[offset + i] ^ maskKey[i % 4];
    }
    this._buf = this._buf.slice(offset + payloadLen);

    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === OP_PING) {
      try { this._socket.write(encodeFrame(OP_PONG, payload)); } catch (e) { /* ignore */ }
      return;
    }
    if (opcode === OP_PONG) {
      this.emit('pong', payload);
      return;
    }
    if (opcode === OP_CLOSE) {
      // Echo the close frame and end.
      if (this.readyState === STATE_OPEN) {
        try { this._socket.write(encodeFrame(OP_CLOSE, payload)); } catch (e) { /* ignore */ }
      }
      this.readyState = STATE_CLOSING;
      this._socket.end();
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (!fin) {
        this._fragments = [payload];
        this._fragmentOpcode = opcode;
        return;
      }
      this.emit('message', payload);
      return;
    }
    if (opcode === OP_CONTINUATION) {
      this._fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this._fragments);
        this._fragments = [];
        this.emit('message', full);
      }
      return;
    }
    this._failConnection(1002, 'Unknown opcode');
  }

  _failConnection(code, reason) {
    try { this.close(code, reason); }
    catch (e) { /* ignore */ }
    this.terminate();
  }
}

// ── WebSocketServer ─────────────────────────────────────────────────────────

class WebSocketServer extends EventEmitter {
  constructor(options) {
    super();
    options = options || {};
    if (!options.noServer) {
      throw new Error('Only { noServer: true } mode is supported');
    }
    this.clients = new Set();
  }

  handleUpgrade(req, socket, head, callback) {
    const headers = req.headers || {};
    const upgrade = (headers.upgrade || '').toLowerCase();
    const key = headers['sec-websocket-key'];
    const version = headers['sec-websocket-version'];

    if (upgrade !== 'websocket' || !key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = acceptKey(key);
    const responseLines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      '',
      '',
    ];
    socket.write(responseLines.join('\r\n'));

    // No TCP-level latency wins for our small JSON traffic, but mirrors
    // ws@8's default for parity.
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);

    const ws = new WebSocket(socket);
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));

    // If the upgrade payload arrived in the same TCP read as the request,
    // feed it to the parser.
    if (head && head.length > 0) {
      ws._onData(head);
    }

    callback(ws);
  }
}

module.exports = {
  WebSocketServer,
  WebSocket,
  // Exposed for tests:
  _encodeFrame: encodeFrame,
  _acceptKey: acceptKey,
};
