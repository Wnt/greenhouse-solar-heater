'use strict';

// Holds the live ML forecast model and persists the latest accepted
// model to S3 so it survives pod restarts.
//
// Boot order (loadInitial):
//   1. committed forecast-model.json.gz — always present, the fallback
//   2. S3 latest-accepted model — overrides 1 when present, valid, and
//      at least as fresh
//
// The trainer calls set() after a candidate clears the gate. S3 is
// optional: with no S3_* env the store runs in-memory + committed only.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { FEATURE_NAMES, MODEL_VERSION } = require('./features');

const COMMITTED_PATH = path.join(__dirname, 'forecast-model.json.gz');

function s3Config() {
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
    key: process.env.MODEL_S3_KEY || 'forecast-model.json',
  };
}

// A model is usable only if its feature contract matches the running
// code AND its target-semantics version matches. The version check
// catches changes the feature-name check can't see — e.g. v2 moved
// targets from absolute ΔT to physics-residual ΔT, so an old v1
// forest composed into the v2 rollout would silently double-count.
function contractOk(model) {
  return !!model && !!model.tank && !!model.greenhouse
    && model.version === MODEL_VERSION
    && Array.isArray(model.featureNames)
    && model.featureNames.length === FEATURE_NAMES.length
    && model.featureNames.every(function eq(n, i) { return n === FEATURE_NAMES[i]; });
}

function trainedMs(model) {
  return (model && Date.parse(model.trainedAt)) || 0;
}

function createModelStore(opts) {
  const log = opts.log;
  let current = null;
  let source = 'none';

  function s3client() {
    const cfg = s3Config();
    const { S3Client } = require('../../s3-client');
    return {
      cfg,
      client: new S3Client({
        endpoint: cfg.endpoint, region: cfg.region,
        credentials: cfg.credentials, forcePathStyle: true,
      }),
    };
  }

  // S3 objects wrap the gzipped model as base64 inside JSON, so the
  // hand-rolled S3 client's text transform is enough (no binary path).
  function s3Read(callback) {
    if (!s3Config()) { callback(null, null); return; }
    const { cfg, client } = s3client();
    const { GetObjectCommand } = require('../../s3-client');
    client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.key }))
      .then(function (r) { return r.Body.transformToString(); })
      .then(function (str) {
        const wrap = JSON.parse(str);
        const buf = Buffer.from(wrap.payload, 'base64');
        callback(null, JSON.parse(zlib.gunzipSync(buf).toString('utf8')));
      })
      .catch(function (err) {
        if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
          callback(null, null);
        } else {
          callback(err);
        }
      });
  }

  function s3Write(model, callback) {
    if (!s3Config()) { callback(null); return; }
    const { cfg, client } = s3client();
    const { PutObjectCommand } = require('../../s3-client');
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(model), 'utf8'), { level: 9 });
    const wrap = JSON.stringify({
      format: 'gzip-base64',
      trainedAt: model.trainedAt || null,
      payload: gz.toString('base64'),
    });
    client.send(new PutObjectCommand({
      Bucket: cfg.bucket, Key: cfg.key, Body: wrap, ContentType: 'application/json',
    })).then(function () { callback(null); }).catch(callback);
  }

  // Synchronous committed load + async S3 override, so the handler
  // always has a model the moment loadInitial returns.
  function loadInitial(callback) {
    try {
      current = JSON.parse(zlib.gunzipSync(fs.readFileSync(COMMITTED_PATH)).toString('utf8'));
      source = 'committed';
    } catch (e) {
      log.error('model-store: committed model load failed', { error: e.message });
    }
    s3Read(function (err, m) {
      if (err) {
        log.warn('model-store: S3 model load failed', { error: err.message });
      } else if (m && !contractOk(m)) {
        log.warn('model-store: S3 model rejected — feature contract mismatch');
      } else if (m && trainedMs(m) >= trainedMs(current)) {
        current = m;
        source = 's3';
        log.info('model-store: loaded model from S3', { trainedAt: m.trainedAt });
      }
      if (callback) callback();
    });
  }

  // Promote a freshly-trained model: hot-swap in memory, persist to S3.
  function set(model, callback) {
    current = model;
    source = 'trained';
    s3Write(model, function (err) {
      if (err) log.warn('model-store: S3 persist failed', { error: err.message });
      else log.info('model-store: model persisted to S3', { trainedAt: model.trainedAt });
      if (callback) callback();
    });
  }

  return {
    loadInitial,
    set,
    get: function () { return current; },
    getInfo: function () {
      return { source, trainedAt: (current && current.trainedAt) || null };
    },
  };
}

module.exports = { createModelStore, contractOk };
