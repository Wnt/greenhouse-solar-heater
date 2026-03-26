/**
 * S3-compatible storage adapter for push notification data.
 * Stores VAPID keys and push subscriptions in S3 or local filesystem.
 * Follows the same pattern as s3-storage.js.
 *
 * S3 keys:
 *   push-config.json        - VAPID key pair + subject
 *   push-subscriptions.json - Array of push subscription objects
 *
 * Environment variables: same as s3-storage.js (S3_ENDPOINT, S3_BUCKET, etc.)
 * Additional:
 *   PUSH_CONFIG_KEY          - S3 key for VAPID config (default: push-config.json)
 *   PUSH_SUBSCRIPTIONS_KEY   - S3 key for subscriptions (default: push-subscriptions.json)
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

// ── Generic S3 read/write ──

function readS3(key, callback) {
  var config = getS3Config();
  var GetObjectCommand = require('@aws-sdk/client-s3').GetObjectCommand;
  var client = getS3Client();
  var cmd = new GetObjectCommand({ Bucket: config.bucket, Key: key });
  client.send(cmd).then(function (response) {
    return response.Body.transformToString();
  }).then(function (bodyStr) {
    try {
      callback(null, JSON.parse(bodyStr));
    } catch (e) {
      callback(new Error('Failed to parse S3 object as JSON'));
    }
  }).catch(function (err) {
    if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
      callback(null, null);
    } else {
      callback(err);
    }
  });
}

function writeS3(key, data, callback) {
  var config = getS3Config();
  var PutObjectCommand = require('@aws-sdk/client-s3').PutObjectCommand;
  var client = getS3Client();
  var body = JSON.stringify(data, null, 2);
  var cmd = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: 'application/json',
  });
  client.send(cmd).then(function () {
    callback(null);
  }).catch(function (err) {
    callback(err);
  });
}

// ── Generic local read/write ──

function getLocalDir() {
  return process.env.PUSH_DATA_DIR || path.join(__dirname, '..', 'data');
}

function readLocal(filename, callback) {
  var filePath = path.join(getLocalDir(), filename);
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

function writeLocal(filename, data, callback) {
  var dir = getLocalDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    var filePath = path.join(dir, filename);
    var tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, filePath);
    callback(null);
  } catch (err) {
    callback(err);
  }
}

// ── VAPID keys ──

var VAPID_KEY = process.env.PUSH_CONFIG_KEY || 'push-config.json';

function loadVapidKeys(callback) {
  if (isS3Enabled()) {
    readS3(VAPID_KEY, callback);
  } else {
    readLocal(VAPID_KEY, callback);
  }
}

function saveVapidKeys(data, callback) {
  if (isS3Enabled()) {
    writeS3(VAPID_KEY, data, callback);
  } else {
    writeLocal(VAPID_KEY, data, callback);
  }
}

// ── Push subscriptions ──

var SUBS_KEY = process.env.PUSH_SUBSCRIPTIONS_KEY || 'push-subscriptions.json';

function loadSubscriptions(callback) {
  if (isS3Enabled()) {
    readS3(SUBS_KEY, function (err, data) {
      callback(err, data || []);
    });
  } else {
    readLocal(SUBS_KEY, function (err, data) {
      callback(err, data || []);
    });
  }
}

function saveSubscriptions(data, callback) {
  if (isS3Enabled()) {
    writeS3(SUBS_KEY, data, callback);
  } else {
    writeLocal(SUBS_KEY, data, callback);
  }
}

function addSubscription(sub, callback) {
  loadSubscriptions(function (err, subs) {
    if (err) { callback(err); return; }
    // Deduplicate by endpoint
    var existing = false;
    for (var i = 0; i < subs.length; i++) {
      if (subs[i].endpoint === sub.endpoint) {
        subs[i] = sub;
        existing = true;
        break;
      }
    }
    if (!existing) {
      subs.push(sub);
    }
    saveSubscriptions(subs, function (saveErr) {
      callback(saveErr, existing);
    });
  });
}

function removeSubscription(endpoint, callback) {
  loadSubscriptions(function (err, subs) {
    if (err) { callback(err); return; }
    var filtered = subs.filter(function (s) { return s.endpoint !== endpoint; });
    var removed = filtered.length < subs.length;
    saveSubscriptions(filtered, function (saveErr) {
      callback(saveErr, removed);
    });
  });
}

// Reset cached clients (for testing)
function _reset() {
  s3Client = null;
  s3Config = null;
}

module.exports = {
  isS3Enabled: isS3Enabled,
  loadVapidKeys: loadVapidKeys,
  saveVapidKeys: saveVapidKeys,
  loadSubscriptions: loadSubscriptions,
  saveSubscriptions: saveSubscriptions,
  addSubscription: addSubscription,
  removeSubscription: removeSubscription,
  _reset: _reset,
};
