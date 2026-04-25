#!/usr/bin/env node
/**
 * VPN config S3 persistence helper.
 * Downloads or uploads OpenVPN config (openvpn.conf) to/from S3.
 *
 * Usage:
 *   node monitor/lib/vpn-config.js download /opt/app/openvpn.conf
 *   node monitor/lib/vpn-config.js upload /opt/app/openvpn.conf
 *
 * Environment variables (same as s3-storage.js):
 *   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION
 *   VPN_CONFIG_KEY - S3 object key (default: openvpn.conf)
 */

const fs = require('fs');
const path = require('path');

let s3Client = null;

function getS3Config() {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    region: process.env.S3_REGION || 'europe-1',
    credentials: { accessKeyId, secretAccessKey },
    key: process.env.VPN_CONFIG_KEY || 'openvpn.conf',
  };
}

function getS3Client(config) {
  if (s3Client) return s3Client;
  const S3Client = require('./s3-client').S3Client;
  s3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });
  return s3Client;
}

function download(localPath, callback) {
  const config = getS3Config();
  if (!config) {
    callback(new Error('S3 not configured'));
    return;
  }
  const GetObjectCommand = require('./s3-client').GetObjectCommand;
  const client = getS3Client(config);
  const cmd = new GetObjectCommand({ Bucket: config.bucket, Key: config.key });
  client.send(cmd).then(function (response) {
    return response.Body.transformToString();
  }).then(function (body) {
    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Write to temp file first, then rename — prevents truncating
    // the existing config if the write fails (e.g. disk full)
    const tmpPath = localPath + '.tmp';
    fs.writeFileSync(tmpPath, body);
    fs.renameSync(tmpPath, localPath);
    callback(null, 'downloaded');
  }).catch(function (err) {
    if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
      callback(null, 'not-found');
    } else {
      callback(err);
    }
  });
}

function upload(localPath, callback) {
  const config = getS3Config();
  if (!config) {
    callback(new Error('S3 not configured'));
    return;
  }
  if (!fs.existsSync(localPath)) {
    callback(new Error('Local file not found: ' + localPath));
    return;
  }

  // Check if S3 already has this config (skip unnecessary writes)
  const s3 = require('./s3-client');
  const client = getS3Client(config);
  const headCmd = new s3.HeadObjectCommand({ Bucket: config.bucket, Key: config.key });
  client.send(headCmd).then(function () {
    // Object exists in S3 — skip upload
    callback(null, 'already-exists');
  }).catch(function (err) {
    if (err.name === 'NotFound' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
      // Object doesn't exist — upload it
      const body = fs.readFileSync(localPath, 'utf8');
      const putCmd = new s3.PutObjectCommand({
        Bucket: config.bucket,
        Key: config.key,
        Body: body,
        ContentType: 'text/plain',
      });
      client.send(putCmd).then(function () {
        callback(null, 'uploaded');
      }).catch(function (putErr) {
        callback(putErr);
      });
    } else {
      callback(err);
    }
  });
}

// ── CLI entrypoint ──

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const localPath = args[1];

  if (!command || !localPath) {
    console.error('Usage: node vpn-config.js <download|upload> <path>');
    process.exit(1);
  }

  if (command === 'download') {
    download(localPath, function (err, result) {
      if (err) {
        console.error('[vpn-config] Download error: ' + err.message);
        process.exit(1);
      }
      if (result === 'not-found') {
        console.log('[vpn-config] No VPN config found in S3 — skipping');
        process.exit(0);
      }
      console.log('[vpn-config] Downloaded VPN config to ' + localPath);
    });
  } else if (command === 'upload') {
    upload(localPath, function (err, result) {
      if (err) {
        console.error('[vpn-config] Upload error: ' + err.message);
        process.exit(1);
      }
      if (result === 'already-exists') {
        console.log('[vpn-config] VPN config already in S3 — skipping upload');
        process.exit(0);
      }
      console.log('[vpn-config] Uploaded VPN config to S3');
    });
  } else {
    console.error('Unknown command: ' + command + '. Use "download" or "upload".');
    process.exit(1);
  }
}

// Run CLI if executed directly, export functions for testing
if (require.main === module) {
  main();
} else {
  module.exports = {
    download,
    upload,
    _resetClient: function () { s3Client = null; },
  };
}
