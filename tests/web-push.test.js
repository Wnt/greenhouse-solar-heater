const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const wp = require('../server/lib/web-push.js');

describe('web-push VAPID', () => {
  beforeEach(() => wp._reset());

  it('generateVAPIDKeys returns base64url public/private keys of correct length', () => {
    const keys = wp.generateVAPIDKeys();
    assert.match(keys.publicKey, /^[A-Za-z0-9_-]+$/);
    assert.match(keys.privateKey, /^[A-Za-z0-9_-]+$/);
    assert.strictEqual(wp._b64uDecode(keys.publicKey).length, 65);
    assert.strictEqual(wp._b64uDecode(keys.privateKey).length, 32);
    assert.strictEqual(wp._b64uDecode(keys.publicKey)[0], 0x04);
  });

  it('buildVapidJwt produces a valid ES256-signed JWT verifiable with the public key', () => {
    const keys = wp.generateVAPIDKeys();
    wp.setVapidDetails('mailto:test@example.com', keys.publicKey, keys.privateKey);
    const jwt = wp._buildVapidJwt('https://push.example.com');

    const parts = jwt.split('.');
    assert.strictEqual(parts.length, 3);

    // Header decodes
    const header = JSON.parse(wp._b64uDecode(parts[0]).toString('utf8'));
    assert.strictEqual(header.alg, 'ES256');
    assert.strictEqual(header.typ, 'JWT');

    // Claims decode
    const claims = JSON.parse(wp._b64uDecode(parts[1]).toString('utf8'));
    assert.strictEqual(claims.aud, 'https://push.example.com');
    assert.strictEqual(claims.sub, 'mailto:test@example.com');
    assert.ok(claims.exp > Math.floor(Date.now() / 1000));

    // Signature verifies under the published public key.
    const pubBytes = wp._b64uDecode(keys.publicKey);
    const x = pubBytes.slice(1, 33);
    const y = pubBytes.slice(33, 65);
    const pubKey = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: wp._b64uEncode(x), y: wp._b64uEncode(y) },
      format: 'jwk',
    });
    const signature = wp._b64uDecode(parts[2]);
    const signingInput = parts[0] + '.' + parts[1];
    const ok = crypto.verify('SHA256', Buffer.from(signingInput, 'utf8'),
      { key: pubKey, dsaEncoding: 'ieee-p1363' }, signature);
    assert.strictEqual(ok, true);
  });

  it('rejects invalid VAPID subject', () => {
    assert.throws(() => wp.setVapidDetails('not-a-url', 'a', 'b'));
  });
});

describe('web-push aes128gcm encryption (RFC 8291)', () => {
  it('round-trips: receiver can decrypt what we encrypt', () => {
    // Receiver-side keypair, as if from the browser PushManager.
    const receiver = crypto.createECDH('prime256v1');
    receiver.generateKeys();
    const receiverPub = receiver.getPublicKey(null, 'uncompressed');
    const authSecret = crypto.randomBytes(16);

    const plaintext = Buffer.from('{"title":"hello","body":"world"}', 'utf8');
    const encrypted = wp._encryptPayload(
      plaintext,
      wp._b64uEncode(receiverPub),
      wp._b64uEncode(authSecret)
    );

    // Parse header per RFC 8188.
    const salt = encrypted.slice(0, 16);
    const rs = encrypted.readUInt32BE(16);
    const idlen = encrypted[20];
    const senderPub = encrypted.slice(21, 21 + idlen);
    const ciphertextAndTag = encrypted.slice(21 + idlen);
    assert.strictEqual(idlen, 65);
    assert.strictEqual(rs, 4096);
    assert.strictEqual(senderPub[0], 0x04);

    // Receiver derives the same CEK and nonce.
    const sharedSecret = receiver.computeSecret(senderPub);
    const prkKey = crypto.createHmac('sha256', authSecret).update(sharedSecret).digest();
    const keyInfo = Buffer.concat([
      Buffer.from('WebPush: info\0', 'utf8'),
      receiverPub,
      senderPub,
    ]);
    const ikm = crypto.createHmac('sha256', prkKey)
      .update(Buffer.concat([keyInfo, Buffer.from([1])])).digest();
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    const cek = crypto.createHmac('sha256', prk)
      .update(Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])]))
      .digest().slice(0, 16);
    const nonce = crypto.createHmac('sha256', prk)
      .update(Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])]))
      .digest().slice(0, 12);

    // Decrypt.
    const tag = ciphertextAndTag.slice(ciphertextAndTag.length - 16);
    const ciphertext = ciphertextAndTag.slice(0, ciphertextAndTag.length - 16);
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Last byte should be the 0x02 last-record delimiter.
    assert.strictEqual(decrypted[decrypted.length - 1], 0x02);
    assert.strictEqual(decrypted.slice(0, -1).toString('utf8'), plaintext.toString('utf8'));
  });
});

describe('web-push sendNotification', () => {
  beforeEach(() => wp._reset());

  function fakeReceiverSubscription() {
    const receiver = crypto.createECDH('prime256v1');
    receiver.generateKeys();
    return {
      endpoint: 'https://push.example.com/abc123',
      keys: {
        p256dh: wp._b64uEncode(receiver.getPublicKey(null, 'uncompressed')),
        auth: wp._b64uEncode(crypto.randomBytes(16)),
      },
    };
  }

  it('rejects when VAPID details are not set', async () => {
    await assert.rejects(
      wp.sendNotification(fakeReceiverSubscription(), 'hi'),
      /VAPID details not set/
    );
  });

  it('POSTs to the endpoint with VAPID Authorization, TTL, and aes128gcm body', async () => {
    const keys = wp.generateVAPIDKeys();
    wp.setVapidDetails('mailto:t@example.com', keys.publicKey, keys.privateKey);

    let captured = null;
    wp._setTransport((url, opts, body) => {
      captured = { url, opts, body };
      return Promise.resolve({ statusCode: 201, headers: {}, body: Buffer.from('') });
    });

    const sub = fakeReceiverSubscription();
    const res = await wp.sendNotification(sub, '{"x":1}');
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(captured.url, sub.endpoint);
    assert.strictEqual(captured.opts.method, 'POST');
    assert.strictEqual(captured.opts.headers['Content-Encoding'], 'aes128gcm');
    assert.strictEqual(captured.opts.headers.TTL, '86400');
    assert.match(captured.opts.headers.Authorization, /^vapid t=eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/);
    assert.ok(Buffer.isBuffer(captured.body));
    assert.ok(captured.body.length > 86); // header(86) + ciphertext + tag
  });

  it('rejects with err.statusCode when push service returns 410', async () => {
    const keys = wp.generateVAPIDKeys();
    wp.setVapidDetails('mailto:t@example.com', keys.publicKey, keys.privateKey);
    wp._setTransport(() => Promise.resolve({ statusCode: 410, headers: {}, body: Buffer.from('gone') }));

    await assert.rejects(
      wp.sendNotification(fakeReceiverSubscription(), 'hi'),
      (err) => {
        assert.strictEqual(err.statusCode, 410);
        return true;
      }
    );
  });
});
