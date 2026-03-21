/**
 * S3-compatible storage adapter for credentials persistence.
 * Falls back to local filesystem when S3 is not configured.
 *
 * Environment variables:
 *   S3_ENDPOINT          - Object Storage endpoint URL (required for S3 mode)
 *   S3_BUCKET            - Bucket name (required for S3 mode)
 *   S3_ACCESS_KEY_ID     - Access key ID (required for S3 mode)
 *   S3_SECRET_ACCESS_KEY - Secret access key (required for S3 mode)
 *   S3_REGION            - Region (default: europe-1)
 *   CREDENTIALS_KEY      - Object key (default: credentials.json)
 *   CREDENTIALS_PATH     - Local file path (used in fallback/local mode)
 */

var fs = require('fs');
var path = require('path');

var s3Client = null;
var s3Config = null;

function getS3Config() {
  if (s3Config) return s3Config;
  var endpoint = process.env.S3_ENDPOINT;
  var bucket = process.env.S3_BUCKET;
  var accessKeyId = process.env.S3_ACCESS_KEY_ID;
  var secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  s3Config = {
    endpoint: endpoint,
    bucket: bucket,
    region: process.env.S3_REGION || 'europe-1',
    credentials: { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey },
    key: process.env.CREDENTIALS_KEY || 'credentials.json',
  };
  return s3Config;
}

function isS3Enabled() {
  return getS3Config() !== null;
}

function getS3Client() {
  if (s3Client) return s3Client;
  var config = getS3Config();
  var S3Client = require('@aws-sdk/client-s3').S3Client;
  s3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });
  return s3Client;
}

// ── S3 operations ──

function readS3(callback) {
  var config = getS3Config();
  var GetObjectCommand = require('@aws-sdk/client-s3').GetObjectCommand;
  var client = getS3Client();
  var cmd = new GetObjectCommand({ Bucket: config.bucket, Key: config.key });
  client.send(cmd).then(function (response) {
    return response.Body.transformToString();
  }).then(function (bodyStr) {
    try {
      callback(null, JSON.parse(bodyStr));
    } catch (e) {
      callback(new Error('Failed to parse S3 object as JSON'));
    }
  }).catch(function (err) {
    if (err.name === 'NoSuchKey' || err.$metadata && err.$metadata.httpStatusCode === 404) {
      callback(null, null);
    } else {
      callback(err);
    }
  });
}

function writeS3(data, callback) {
  var config = getS3Config();
  var PutObjectCommand = require('@aws-sdk/client-s3').PutObjectCommand;
  var client = getS3Client();
  var body = JSON.stringify(data, null, 2);
  var cmd = new PutObjectCommand({
    Bucket: config.bucket,
    Key: config.key,
    Body: body,
    ContentType: 'application/json',
  });
  client.send(cmd).then(function () {
    callback(null);
  }).catch(function (err) {
    callback(err);
  });
}

// ── Local filesystem operations ──

function getLocalPath() {
  return process.env.CREDENTIALS_PATH || path.join(__dirname, '..', 'auth', 'credentials.json');
}

function readLocal(callback) {
  var filePath = getLocalPath();
  try {
    var data = fs.readFileSync(filePath, 'utf8');
    callback(null, JSON.parse(data));
  } catch (err) {
    if (err.code === 'ENOENT') {
      callback(null, null);
    } else {
      callback(err);
    }
  }
}

function writeLocal(data, callback) {
  var filePath = getLocalPath();
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    callback(null);
  } catch (err) {
    callback(err);
  }
}

// ── Public API ──

function read(callback) {
  if (isS3Enabled()) {
    readS3(callback);
  } else {
    readLocal(callback);
  }
}

function write(data, callback) {
  if (isS3Enabled()) {
    writeS3(data, callback);
  } else {
    writeLocal(data, callback);
  }
}

// Synchronous read for backward compatibility (local mode only)
function readSync() {
  var filePath = getLocalPath();
  try {
    var data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Synchronous write for backward compatibility (local mode only)
function writeSync(data) {
  var filePath = getLocalPath();
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Reset cached clients (for testing)
function _reset() {
  s3Client = null;
  s3Config = null;
}

module.exports = {
  isS3Enabled: isS3Enabled,
  read: read,
  write: write,
  readSync: readSync,
  writeSync: writeSync,
  _reset: _reset,
};
