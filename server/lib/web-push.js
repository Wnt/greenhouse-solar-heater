/**
 * Minimal Web Push client. Implements:
 *   - VAPID (RFC 8292) JWT authentication
 *   - aes128gcm payload encryption (RFC 8188 / RFC 8291)
 *
 * API (drop-in shape):
 *   const wp = require('./web-push');
 *   const { publicKey, privateKey } = wp.generateVAPIDKeys();
 *   wp.setVapidDetails('mailto:admin@example.com', publicKey, privateKey);
 *   wp.sendNotification({ endpoint, keys: { p256dh, auth } }, JSON.stringify({...}))
 *     .then(...).catch(err => err.statusCode);
 */

'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// ── Base64-URL ──────────────────────────────────────────────────────────────

function b64uEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  const pad = (4 - (str.length % 4)) % 4;
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad), 'base64');
}

// ── HKDF-SHA-256 (output ≤ 32 bytes — single-block expand) ──────────────────

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}
function hkdfExpand(prk, info, length) {
  // T(1) = HMAC(PRK, info || 0x01); we never need more than one block here.
  return hmacSha256(prk, Buffer.concat([info, Buffer.from([1])])).slice(0, length);
}

// ── VAPID keys (P-256 ECDSA / ECDH) ─────────────────────────────────────────

function generateVAPIDKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  // getPrivateKey() returns the BIGNUM with leading-zero bytes
  // stripped, so ~1/256 of the time the result is 31 bytes (or fewer)
  // instead of the 32 bytes JWK / web-push consumers expect. Left-pad
  // to a fixed 32 bytes.
  let privateKey = ecdh.getPrivateKey();
  if (privateKey.length < 32) {
    privateKey = Buffer.concat([Buffer.alloc(32 - privateKey.length), privateKey]);
  }
  return {
    publicKey: b64uEncode(ecdh.getPublicKey(null, 'uncompressed')),  // 65 bytes
    privateKey: b64uEncode(privateKey),                              // 32 bytes
  };
}

let vapidSubject = null;
let vapidPublicKey = null;
let vapidPrivateKey = null;
let cachedPrivateKeyObject = null;

function setVapidDetails(subject, publicKey, privateKey) {
  if (!subject || (!subject.startsWith('mailto:') && !subject.startsWith('http'))) {
    throw new Error('VAPID subject must be a mailto: or https: URL');
  }
  vapidSubject = subject;
  vapidPublicKey = publicKey;
  vapidPrivateKey = privateKey;
  cachedPrivateKeyObject = null;
}

// Build a Node KeyObject from raw VAPID material so we can sign with
// dsaEncoding: 'ieee-p1363' (raw r||s, as JWT requires).
function getVapidPrivateKeyObject() {
  if (cachedPrivateKeyObject) return cachedPrivateKeyObject;
  const pub = b64uDecode(vapidPublicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be 65-byte uncompressed P-256');
  }
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const d = b64uDecode(vapidPrivateKey);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64uEncode(x),
    y: b64uEncode(y),
    d: b64uEncode(d),
  };
  cachedPrivateKeyObject = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return cachedPrivateKeyObject;
}

function buildVapidJwt(audience, expSeconds) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const exp = Math.floor(Date.now() / 1000) + (expSeconds || 12 * 60 * 60);
  const claims = { aud: audience, exp, sub: vapidSubject };
  const signingInput =
    b64uEncode(Buffer.from(JSON.stringify(header), 'utf8')) + '.' +
    b64uEncode(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = crypto.sign('SHA256', Buffer.from(signingInput, 'utf8'), {
    key: getVapidPrivateKeyObject(),
    dsaEncoding: 'ieee-p1363',
  });
  return signingInput + '.' + b64uEncode(sig);
}

// ── aes128gcm payload encryption (RFC 8291) ─────────────────────────────────

const AES128GCM_HEADER_RS = 4096;

function encryptPayload(plaintext, userP256dh, userAuth) {
  const uaPub = b64uDecode(userP256dh);  // 65-byte uncompressed point
  const auth = b64uDecode(userAuth);     // 16-byte auth secret
  if (uaPub.length !== 65 || uaPub[0] !== 0x04) {
    throw new Error('Subscription p256dh must be 65-byte uncompressed P-256');
  }

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const senderPub = ecdh.getPublicKey(null, 'uncompressed');
  const sharedSecret = ecdh.computeSecret(uaPub);

  // RFC 8291 §3.4 key derivation.
  const prkKey = hkdfExtract(auth, sharedSecret);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    uaPub,
    senderPub,
  ]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);

  const salt = crypto.randomBytes(16);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // Plaintext = data || 0x02 (last-record delimiter, no extra padding).
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Header: salt(16) || rs(4 BE) || idlen(1) || keyid(=senderPub, 65)
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(AES128GCM_HEADER_RS, 0);
  const header = Buffer.concat([
    salt,
    rsBuf,
    Buffer.from([senderPub.length]),
    senderPub,
  ]);

  return Buffer.concat([header, encrypted, tag]);
}

// ── HTTP send ───────────────────────────────────────────────────────────────

let httpRequest = function (urlStr, options, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: options.method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      headers: options.headers,
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
};

function sendNotification(subscription, payload, options) {
  options = options || {};
  // Wrap in Promise.resolve() so that any synchronous validation throw
  // (invalid keys, missing VAPID details, etc.) surfaces as a rejection
  // instead of an exception. Matches web-push@3 behaviour.
  return Promise.resolve().then(function () {
    if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
      throw new Error('VAPID details not set — call setVapidDetails first');
    }
    if (!subscription || !subscription.endpoint || !subscription.keys
        || !subscription.keys.p256dh || !subscription.keys.auth) {
      throw new Error('Invalid push subscription');
    }

    let body = null;
    let contentEncoding = null;
    if (payload != null && payload.length > 0) {
      const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
      body = encryptPayload(plaintext, subscription.keys.p256dh, subscription.keys.auth);
      contentEncoding = 'aes128gcm';
    }

    const endpointUrl = new URL(subscription.endpoint);
    const audience = endpointUrl.protocol + '//' + endpointUrl.host;
    const jwt = buildVapidJwt(audience);

    const headers = {
      'Authorization': 'vapid t=' + jwt + ', k=' + vapidPublicKey,
      'TTL': String(options.TTL || 86400),
    };
    if (body) {
      headers['Content-Encoding'] = contentEncoding;
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = String(body.length);
    } else {
      headers['Content-Length'] = '0';
    }

    return httpRequest(subscription.endpoint, { method: 'POST', headers }, body);
  }).then(function (res) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return {
        statusCode: res.statusCode,
        headers: res.headers,
        body: res.body.toString('utf8'),
      };
    }
    const err = new Error('Push send failed: HTTP ' + res.statusCode + ' '
      + (res.body ? res.body.toString('utf8').slice(0, 300) : ''));
    err.statusCode = res.statusCode;
    err.headers = res.headers;
    err.body = res.body ? res.body.toString('utf8') : '';
    throw err;
  });
}

module.exports = {
  generateVAPIDKeys,
  setVapidDetails,
  sendNotification,
  // Exposed for tests:
  _b64uEncode: b64uEncode,
  _b64uDecode: b64uDecode,
  _buildVapidJwt: buildVapidJwt,
  _encryptPayload: encryptPayload,
  _setTransport: function (fn) { httpRequest = fn; },
  _reset: function () {
    vapidSubject = null;
    vapidPublicKey = null;
    vapidPrivateKey = null;
    cachedPrivateKeyObject = null;
  },
};
