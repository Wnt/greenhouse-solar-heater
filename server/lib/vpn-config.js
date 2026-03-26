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

var fs = require('fs');
var path = require('path');

var s3Client = null;

function getS3Config() {
  var endpoint = process.env.S3_ENDPOINT;
  var bucket = process.env.S3_BUCKET;
  var accessKeyId = process.env.S3_ACCESS_KEY_ID;
  var secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint,
    bucket: bucket,
    region: process.env.S3_REGION || 'europe-1',
    credentials: { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey },
    key: process.env.VPN_CONFIG_KEY || 'openvpn.conf',
  };
}

function getS3Client(config) {
  if (s3Client) return s3Client;
  var S3Client = require('@aws-sdk/client-s3').S3Client;
  s3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });
  return s3Client;
}

function download(localPath, callback) {
  var config = getS3Config();
  if (!config) {
    callback(new Error('S3 not configured'));
    return;
  }
  var GetObjectCommand = require('@aws-sdk/client-s3').GetObjectCommand;
  var client = getS3Client(config);
  var cmd = new GetObjectCommand({ Bucket: config.bucket, Key: config.key });
  client.send(cmd).then(function (response) {
    return response.Body.transformToString();
  }).then(function (body) {
    var dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Write to temp file first, then rename — prevents truncating
    // the existing config if the write fails (e.g. disk full)
    var tmpPath = localPath + '.tmp';
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
  var config = getS3Config();
  if (!config) {
    callback(new Error('S3 not configured'));
    return;
  }
  if (!fs.existsSync(localPath)) {
    callback(new Error('Local file not found: ' + localPath));
    return;
  }

  // Check if S3 already has this config (skip unnecessary writes)
  var s3 = require('@aws-sdk/client-s3');
  var client = getS3Client(config);
  var headCmd = new s3.HeadObjectCommand({ Bucket: config.bucket, Key: config.key });
  client.send(headCmd).then(function () {
    // Object exists in S3 — skip upload
    callback(null, 'already-exists');
  }).catch(function (err) {
    if (err.name === 'NotFound' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
      // Object doesn't exist — upload it
      var body = fs.readFileSync(localPath, 'utf8');
      var putCmd = new s3.PutObjectCommand({
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
  var args = process.argv.slice(2);
  var command = args[0];
  var localPath = args[1];

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
    download: download,
    upload: upload,
    _resetClient: function () { s3Client = null; },
  };
}
