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

const fs = require('fs');
const path = require('path');

let s3Client = null;
let s3Config = null;

function getS3Config() {
  if (s3Config) return s3Config;
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  s3Config = {
    endpoint,
    bucket,
    region: process.env.S3_REGION || 'europe-1',
    credentials: { accessKeyId, secretAccessKey },
    key: process.env.CREDENTIALS_KEY || 'credentials.json',
  };
  return s3Config;
}

function isS3Enabled() {
  return getS3Config() !== null;
}

function getS3Client() {
  if (s3Client) return s3Client;
  const config = getS3Config();
  const S3Client = require('./s3-client').S3Client;
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
  const config = getS3Config();
  const GetObjectCommand = require('./s3-client').GetObjectCommand;
  const client = getS3Client();
  const cmd = new GetObjectCommand({ Bucket: config.bucket, Key: config.key });
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
  const config = getS3Config();
  const PutObjectCommand = require('./s3-client').PutObjectCommand;
  const client = getS3Client();
  const body = JSON.stringify(data, null, 2);
  const cmd = new PutObjectCommand({
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
  const filePath = getLocalPath();
  try {
    const data = fs.readFileSync(filePath, 'utf8');
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
  const filePath = getLocalPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
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
  const filePath = getLocalPath();
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Synchronous write for backward compatibility (local mode only)
function writeSync(data) {
  const filePath = getLocalPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// Reset cached clients (for testing)
function _reset() {
  s3Client = null;
  s3Config = null;
}

module.exports = {
  isS3Enabled,
  read,
  write,
  readSync,
  writeSync,
  _reset,
};
