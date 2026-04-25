const { describe, it } = require('node:test');
const assert = require('node:assert');

const s3 = require('../server/lib/s3-client.js');

describe('s3-client SigV4', () => {
  // AWS-published reference vector: "GET Object" example from
  // docs.aws.amazon.com (Signature Version 4 Test Suite, get-object).
  // Verifies the canonical request hashing + signing key derivation.
  it('matches the AWS GET-object reference signature', () => {
    const headers = s3._signRequest({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      headers: { Range: 'bytes=0-9' },
      body: '',
      region: 'us-east-1',
      service: 's3',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      date: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
    });
    assert.strictEqual(headers['x-amz-date'], '20130524T000000Z');
    assert.strictEqual(
      headers['x-amz-content-sha256'],
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    const auth = headers.Authorization;
    assert.match(auth, /^AWS4-HMAC-SHA256 /);
    assert.match(auth, /Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/);
    assert.match(auth, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/);
    assert.match(auth, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41/);
  });

  it('uses payload SHA-256 for non-empty bodies', () => {
    const body = 'Welcome to Amazon S3.';
    const headers = s3._signRequest({
      method: 'PUT',
      url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
      headers: { 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      body,
      region: 'us-east-1',
      service: 's3',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      date: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
    });
    // SHA-256 of 'Welcome to Amazon S3.' per AWS reference.
    assert.strictEqual(
      headers['x-amz-content-sha256'],
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072'
    );
  });

  it('URI-encodes keys with spaces and special chars', () => {
    assert.strictEqual(s3._uriEncode('hello world', true), 'hello%20world');
    assert.strictEqual(s3._uriEncode('a/b/c.txt', false), 'a/b/c.txt');
    assert.strictEqual(s3._uriEncode('a/b/c.txt', true), 'a%2Fb%2Fc.txt');
    // RFC 3986 unreserved
    assert.strictEqual(s3._uriEncode('A-Z_a-z_0-9-._~', true), 'A-Z_a-z_0-9-._~');
  });
});

describe('s3-client commands (mocked transport)', () => {
  function setup() {
    const sent = [];
    const responses = [];
    s3._setTransport(function (opts, body) {
      sent.push({ opts, body });
      const r = responses.shift() || { statusCode: 200, headers: {}, body: Buffer.from('') };
      return Promise.resolve(r);
    });
    return { sent, responses };
  }

  it('GetObject parses 200 response into Body.transformToString', async () => {
    const { responses } = setup();
    responses.push({ statusCode: 200, headers: {}, body: Buffer.from('hello s3', 'utf8') });
    const client = new s3.S3Client({
      endpoint: 'https://obj.example.com',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    });
    const res = await client.send(new s3.GetObjectCommand({ Bucket: 'b', Key: 'k.json' }));
    const body = await res.Body.transformToString();
    assert.strictEqual(body, 'hello s3');
  });

  it('GetObject 404 → err.name=NoSuchKey, err.$metadata.httpStatusCode=404', async () => {
    const { responses } = setup();
    responses.push({ statusCode: 404, headers: {}, body: Buffer.from('') });
    const client = new s3.S3Client({
      endpoint: 'https://obj.example.com',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    });
    await assert.rejects(
      client.send(new s3.GetObjectCommand({ Bucket: 'b', Key: 'missing' })),
      function (err) {
        assert.strictEqual(err.name, 'NoSuchKey');
        assert.strictEqual(err.$metadata.httpStatusCode, 404);
        return true;
      }
    );
  });

  it('PutObject signs PUT with content-type and length', async () => {
    const { sent, responses } = setup();
    responses.push({ statusCode: 200, headers: {}, body: Buffer.from('') });
    const client = new s3.S3Client({
      endpoint: 'https://obj.example.com',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    });
    await client.send(new s3.PutObjectCommand({
      Bucket: 'b',
      Key: 'k.json',
      Body: '{"x":1}',
      ContentType: 'application/json',
    }));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].opts.method, 'PUT');
    assert.strictEqual(sent[0].opts.url, 'https://obj.example.com/b/k.json');
    assert.strictEqual(sent[0].opts.headers['content-type'], 'application/json');
    assert.strictEqual(sent[0].opts.headers['content-length'], '7');
    assert.match(sent[0].opts.headers.Authorization, /^AWS4-HMAC-SHA256 /);
  });

  it('HeadObject 404 → err.name=NotFound', async () => {
    const { responses } = setup();
    responses.push({ statusCode: 404, headers: {}, body: Buffer.from('') });
    const client = new s3.S3Client({
      endpoint: 'https://obj.example.com',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    });
    await assert.rejects(
      client.send(new s3.HeadObjectCommand({ Bucket: 'b', Key: 'missing' })),
      function (err) {
        assert.strictEqual(err.name, 'NotFound');
        assert.strictEqual(err.$metadata.httpStatusCode, 404);
        return true;
      }
    );
  });

  it('uses path-style URLs', async () => {
    const { sent, responses } = setup();
    responses.push({ statusCode: 200, headers: {}, body: Buffer.from('x') });
    const client = new s3.S3Client({
      endpoint: 'https://obj.example.com/',
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' },
    });
    await client.send(new s3.GetObjectCommand({ Bucket: 'my-bucket', Key: 'nested/file.txt' }));
    assert.strictEqual(sent[0].opts.url, 'https://obj.example.com/my-bucket/nested/file.txt');
  });
});
