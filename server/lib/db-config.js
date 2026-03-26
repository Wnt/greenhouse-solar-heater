#!/usr/bin/env node
/**
 * Database URL S3 persistence helper.
 * Stores and retrieves the DATABASE_URL from S3 object storage.
 *
 * Usage:
 *   node monitor/lib/db-config.js store "postgres://user:pass@host:port/db"
 *   node monitor/lib/db-config.js load
 *
 * Environment variables (same as s3-storage.js):
 *   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION
 *   DB_CONFIG_KEY - S3 object key (default: database-url.json)
 */

var s3Client = null;

var S3_KEY = process.env.DB_CONFIG_KEY || 'database-url.json';

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
      callback(null, data.url || null, data.ca || null);
    } catch (e) {
      callback(new Error('Failed to parse database config JSON'));
    }
  }).catch(function (err) {
    if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
      callback(null, null, null);
    } else {
      callback(err);
    }
  });
}

function store(url, ca, callback) {
  if (typeof ca === 'function') {
    callback = ca;
    ca = null;
  }
  var config = getS3Config();
  if (!config) {
    callback(new Error('S3 not configured'));
    return;
  }
  var PutObjectCommand = require('@aws-sdk/client-s3').PutObjectCommand;
  var client = getS3Client(config);
  var data = { url: url };
  if (ca) data.ca = ca;
  var body = JSON.stringify(data, null, 2);
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
    load(function (err, url) {
      if (err) {
        console.error('[db-config] Load error: ' + err.message);
        process.exit(1);
      }
      if (!url) {
        console.log('[db-config] No database URL found in S3');
        process.exit(0);
      }
      // Output just the URL for shell consumption
      process.stdout.write(url);
    });
  } else if (command === 'store') {
    var url = args[1];
    if (!url) {
      console.error('Usage: node db-config.js store <database-url> [--ca <cert-file>]');
      process.exit(1);
    }
    var ca = null;
    var caIdx = args.indexOf('--ca');
    if (caIdx !== -1 && args[caIdx + 1]) {
      var fs = require('fs');
      ca = fs.readFileSync(args[caIdx + 1], 'utf8');
    }
    store(url, ca, function (err) {
      if (err) {
        console.error('[db-config] Store error: ' + err.message);
        process.exit(1);
      }
      console.log('[db-config] Database URL' + (ca ? ' and CA cert' : '') + ' stored in S3');
    });
  } else {
    console.error('Usage: node db-config.js <store|load> [url]');
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
