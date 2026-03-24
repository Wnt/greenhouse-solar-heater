#!/usr/bin/env node
/**
 * New Relic license key S3 persistence helper.
 * Stores and retrieves the New Relic license key from S3 object storage.
 *
 * Usage:
 *   node monitor/lib/nr-config.js store "NRAK-XXXXXXXXXXXX"
 *   node monitor/lib/nr-config.js load
 *
 * Environment variables (same as s3-storage.js):
 *   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION
 *   NR_CONFIG_KEY - S3 object key (default: newrelic-config.json)
 */

var s3Client = null;

var S3_KEY = process.env.NR_CONFIG_KEY || 'newrelic-config.json';

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

function load(callback) {
  var config = getS3Config();
  if (!config) {
    callback(new Error('S3 not configured'));
    return;
  }
  var GetObjectCommand = require('@aws-sdk/client-s3').GetObjectCommand;
  var client = getS3Client(config);
  var cmd = new GetObjectCommand({ Bucket: config.bucket, Key: S3_KEY });
  client.send(cmd).then(function (response) {
    return response.Body.transformToString();
  }).then(function (body) {
    try {
      var data = JSON.parse(body);
      callback(null, data.licenseKey || null);
    } catch (e) {
      callback(new Error('Failed to parse New Relic config JSON'));
    }
  }).catch(function (err) {
    if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
      callback(null, null);
    } else {
      callback(err);
    }
  });
}

function store(licenseKey, callback) {
  var config = getS3Config();
  if (!config) {
    callback(new Error('S3 not configured'));
    return;
  }
  var PutObjectCommand = require('@aws-sdk/client-s3').PutObjectCommand;
  var client = getS3Client(config);
  var body = JSON.stringify({ licenseKey: licenseKey }, null, 2);
  var cmd = new PutObjectCommand({
    Bucket: config.bucket,
    Key: S3_KEY,
    Body: body,
    ContentType: 'application/json',
  });
  client.send(cmd).then(function () {
    callback(null, 'stored');
  }).catch(function (err) {
    callback(err);
  });
}

// ── CLI entrypoint ──

function main() {
  var args = process.argv.slice(2);
  var command = args[0];

  if (command === 'load') {
    load(function (err, licenseKey) {
      if (err) {
        console.error('[nr-config] Load error: ' + err.message);
        process.exit(1);
      }
      if (!licenseKey) {
        console.log('[nr-config] No New Relic license key found in S3');
        process.exit(0);
      }
      // Output just the key for shell consumption
      process.stdout.write(licenseKey);
    });
  } else if (command === 'store') {
    var licenseKey = args[1];
    if (!licenseKey) {
      console.error('Usage: node nr-config.js store <license-key>');
      process.exit(1);
    }
    store(licenseKey, function (err) {
      if (err) {
        console.error('[nr-config] Store error: ' + err.message);
        process.exit(1);
      }
      console.log('[nr-config] New Relic license key stored in S3');
    });
  } else {
    console.error('Usage: node nr-config.js <store|load> [license-key]');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    load: load,
    store: store,
    _resetClient: function () { s3Client = null; },
  };
}
