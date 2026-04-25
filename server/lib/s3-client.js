/**
 * Minimal S3-compatible client. Implements GET / PUT / HEAD object with
 * path-style addressing and AWS SigV4 signing — just enough of the SDK
 * API surface that callers can keep their existing call shape.
 *
 * Drop-in shape:
 *   const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('./s3-client');
 *   const c = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
 *   c.send(new GetObjectCommand({ Bucket, Key })).then(r => r.Body.transformToString());
 *
 * Errors mimic the AWS SDK:
 *   - 404 → err.name === 'NoSuchKey' (Get) / 'NotFound' (Head); err.$metadata.httpStatusCode === 404
 *   - other 4xx/5xx → err.$metadata.httpStatusCode set
 */

'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

// AWS SigV4 mandates SHA-256 for the canonical-request and payload digest.
// See docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html.
// Inputs are HTTP request bytes (method, path, headers, body) — never used
// for password storage. CodeQL's js/insufficient-password-hash heuristic
// otherwise flags this when the request body happens to be credential
// material being uploaded to object storage.
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex'); // lgtm [js/insufficient-password-hash]
}
// HMAC-SHA-256 is the SigV4 signing-key derivation primitive (RFC 4868).
// `signingKey` is the staged HMAC chain output, not user-supplied material.
function hmac(signingKey, message) {
  return crypto.createHmac('sha256', signingKey).update(message).digest();
}

// RFC 3986 unreserved chars + percent-encode everything else.
// AWS uses this for path segments and query parameters; '/' is preserved
// in path segments only.
function uriEncode(str, encodeSlash) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i);
    const code = str.charCodeAt(i);
    if (
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) || // 0-9
      ch === '-' || ch === '_' || ch === '.' || ch === '~'
    ) {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += '/';
    } else {
      const bytes = Buffer.from(ch, 'utf8');
      for (let b = 0; b < bytes.length; b++) {
        const hex = bytes[b].toString(16).toUpperCase();
        out += '%' + (hex.length === 1 ? '0' + hex : hex);
      }
    }
  }
  return out;
}

function amzLongDate(d) {
  // yyyyMMddTHHmmssZ
  const iso = d.toISOString();
  return iso.substring(0, 4) + iso.substring(5, 7) + iso.substring(8, 10)
    + 'T' + iso.substring(11, 13) + iso.substring(14, 16) + iso.substring(17, 19) + 'Z';
}

function amzShortDate(d) {
  return amzLongDate(d).substring(0, 8);
}

/**
 * Sign an AWS SigV4 request. Returns a fresh headers object including
 * Authorization, host, x-amz-date, x-amz-content-sha256.
 */
function signRequest(opts) {
  const method = opts.method.toUpperCase();
  const u = new URL(opts.url);
  const date = opts.date || new Date();
  const longDate = amzLongDate(date);
  const shortDate = amzShortDate(date);
  const payload = opts.body == null ? '' : opts.body;
  const payloadHash = payload.length === 0
    ? EMPTY_SHA256
    : sha256Hex(payload);

  const allHeaders = Object.assign({}, opts.headers || {});
  allHeaders.host = u.host;
  allHeaders['x-amz-date'] = longDate;
  allHeaders['x-amz-content-sha256'] = payloadHash;

  // Lowercase header names + trim values (collapse internal whitespace).
  const lcHeaders = {};
  for (const k of Object.keys(allHeaders)) {
    lcHeaders[k.toLowerCase()] = String(allHeaders[k]).trim().replace(/\s+/g, ' ');
  }
  const sortedNames = Object.keys(lcHeaders).sort();
  const canonHeaders = sortedNames.map(n => n + ':' + lcHeaders[n] + '\n').join('');
  const signedHeaders = sortedNames.join(';');

  // Canonical URI = path, each segment URI-encoded but '/' preserved.
  // S3 SigV4 doesn't double-encode the path.
  const canonURI = uriEncode(u.pathname || '/', false) || '/';

  // Canonical query string: keys sorted, both keys and values URI-encoded.
  const params = [];
  for (const [k, v] of u.searchParams.entries()) {
    params.push([uriEncode(k, true), uriEncode(v, true)]);
  }
  params.sort(function (a, b) {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  const canonQuery = params.map(p => p[0] + '=' + p[1]).join('&');

  const canonRequest = [method, canonURI, canonQuery, canonHeaders, signedHeaders, payloadHash].join('\n');

  const credScope = shortDate + '/' + opts.region + '/' + opts.service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', longDate, credScope, sha256Hex(canonRequest)].join('\n');

  const kDate = hmac('AWS4' + opts.credentials.secretAccessKey, shortDate);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authHeader = 'AWS4-HMAC-SHA256 '
    + 'Credential=' + opts.credentials.accessKeyId + '/' + credScope + ', '
    + 'SignedHeaders=' + signedHeaders + ', '
    + 'Signature=' + signature;

  const out = Object.assign({}, allHeaders);
  out.Authorization = authHeader;
  return out;
}

// HTTP transport — Promise-based wrapper over node:http(s).
// Allows test-time injection via S3Client._setTransport(fn).
let httpRequest = function (opts, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(opts.url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: opts.method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      headers: opts.headers,
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

function buildPathStyleUrl(endpoint, bucket, key) {
  const base = endpoint.replace(/\/+$/, '');
  // Bucket name is DNS-compatible (no slashes); encode strictly anyway.
  const encodedBucket = uriEncode(bucket, true);
  // Key may contain '/' separators — preserve them.
  const encodedKey = uriEncode(key, false);
  return base + '/' + encodedBucket + '/' + encodedKey;
}

function classifyError(res, notFoundName) {
  if (res.statusCode === 404) {
    const err = new Error(notFoundName);
    err.name = notFoundName;
    err.$metadata = { httpStatusCode: 404 };
    return err;
  }
  if (res.statusCode >= 400) {
    const bodyStr = res.body ? res.body.toString('utf8').slice(0, 500) : '';
    const err = new Error('S3 request failed: HTTP ' + res.statusCode + (bodyStr ? ': ' + bodyStr : ''));
    err.$metadata = { httpStatusCode: res.statusCode };
    return err;
  }
  return null;
}

class S3Client {
  constructor(config) {
    this.config = {
      endpoint: config.endpoint,
      region: config.region || 'us-east-1',
      credentials: config.credentials,
    };
  }
  send(cmd) {
    return cmd._execute(this.config);
  }
}

class GetObjectCommand {
  constructor(input) { this.input = input; }
  _execute(cfg) {
    const url = buildPathStyleUrl(cfg.endpoint, this.input.Bucket, this.input.Key);
    const headers = signRequest({
      method: 'GET',
      url,
      headers: {},
      body: '',
      region: cfg.region,
      service: 's3',
      credentials: cfg.credentials,
    });
    return httpRequest({ method: 'GET', url, headers }).then(function (res) {
      const err = classifyError(res, 'NoSuchKey');
      if (err) throw err;
      return {
        Body: {
          transformToString: function () { return Promise.resolve(res.body.toString('utf8')); },
        },
        $metadata: { httpStatusCode: res.statusCode },
      };
    });
  }
}

class PutObjectCommand {
  constructor(input) { this.input = input; }
  _execute(cfg) {
    const url = buildPathStyleUrl(cfg.endpoint, this.input.Bucket, this.input.Key);
    const body = Buffer.isBuffer(this.input.Body)
      ? this.input.Body
      : Buffer.from(String(this.input.Body), 'utf8');
    const headers = signRequest({
      method: 'PUT',
      url,
      headers: {
        'content-type': this.input.ContentType || 'application/octet-stream',
        'content-length': String(body.length),
      },
      body,
      region: cfg.region,
      service: 's3',
      credentials: cfg.credentials,
    });
    return httpRequest({ method: 'PUT', url, headers }, body).then(function (res) {
      const err = classifyError(res, 'PutObjectFailed');
      if (err) throw err;
      return { $metadata: { httpStatusCode: res.statusCode } };
    });
  }
}

class HeadObjectCommand {
  constructor(input) { this.input = input; }
  _execute(cfg) {
    const url = buildPathStyleUrl(cfg.endpoint, this.input.Bucket, this.input.Key);
    const headers = signRequest({
      method: 'HEAD',
      url,
      headers: {},
      body: '',
      region: cfg.region,
      service: 's3',
      credentials: cfg.credentials,
    });
    return httpRequest({ method: 'HEAD', url, headers }).then(function (res) {
      const err = classifyError(res, 'NotFound');
      if (err) throw err;
      return { $metadata: { httpStatusCode: res.statusCode } };
    });
  }
}

module.exports = {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  // Exposed for tests:
  _signRequest: signRequest,
  _uriEncode: uriEncode,
  _setTransport: function (fn) { httpRequest = fn; },
};
