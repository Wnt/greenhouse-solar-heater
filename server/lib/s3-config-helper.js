// Shared S3 connection bootstrap. Each consumer (device-config,
// sensor-config, push) used to inline an identical 30-line
// getS3Config / isS3Enabled / getS3Client trio differing only in the
// object key — collapsed here. The S3 key stays consumer-side because
// it identifies a different blob per module.

let cachedConfig = null;
let cachedClient = null;

function getS3CredsConfig() {
  if (cachedConfig) return cachedConfig;
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  cachedConfig = {
    endpoint,
    bucket,
    region: process.env.S3_REGION || 'europe-1',
    credentials: { accessKeyId, secretAccessKey },
  };
  return cachedConfig;
}

function isS3Enabled() {
  return getS3CredsConfig() !== null;
}

function getS3Client() {
  if (cachedClient) return cachedClient;
  const cfg = getS3CredsConfig();
  if (!cfg) return null;
  const { S3Client } = require('./s3-client');
  cachedClient = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: cfg.credentials,
    forcePathStyle: true,
  });
  return cachedClient;
}

function _reset() {
  cachedConfig = null;
  cachedClient = null;
}

module.exports = { getS3CredsConfig, isS3Enabled, getS3Client, _reset };
