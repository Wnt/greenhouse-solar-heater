/**
 * Push notification module.
 * Manages VAPID keys, push subscriptions with per-category opt-in,
 * and sending with per-type rate limiting (1 notification per type per hour).
 *
 * Subscription format in storage:
 *   { vapidKeys: { publicKey, privateKey },
 *     subscriptions: [ { endpoint, keys, categories: [...] }, ... ] }
 *
 * Categories:
 *   - evening_report:  Wh collected during the day (sent ~20:00)
 *   - noon_report:     heating operations during the night (sent ~12:00)
 *   - overheat_warning: tank temp approaching overheat drain threshold
 *   - freeze_warning:   outdoor temp approaching freeze drain threshold
 */

var fs = require('fs');
var path = require('path');
var createLogger = require('./logger');
var log = createLogger('push');

var webpush = null;
var s3Client = null;
var s3Config = null;
var pushData = null;

// Rate-limit map: { type: timestamp_ms }
var lastSentAt = {};

var RATE_LIMIT_MS = 3600000; // 1 hour

var VALID_CATEGORIES = ['evening_report', 'noon_report', 'overheat_warning', 'freeze_warning', 'offline_warning', 'watchdog_fired'];

var S3_KEY = 'push-config.json';
var LOCAL_PATH = process.env.PUSH_CONFIG_PATH || path.join(__dirname, '..', 'push-config.json');

// ── S3 helpers (same pattern as device-config.js) ──

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

// ── Persistence ──

function load(callback) {
  if (isS3Enabled()) {
    var config = getS3Config();
    var GetObjectCommand = require('@aws-sdk/client-s3').GetObjectCommand;
    var client = getS3Client();
    var cmd = new GetObjectCommand({ Bucket: config.bucket, Key: S3_KEY });
    client.send(cmd).then(function (response) {
      return response.Body.transformToString();
    }).then(function (bodyStr) {
      try {
        pushData = JSON.parse(bodyStr);
        callback(null);
      } catch (e) {
        callback(new Error('Failed to parse push config JSON'));
      }
    }).catch(function (err) {
      if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
        pushData = null;
        callback(null);
      } else {
        callback(err);
      }
    });
  } else {
    try {
      var data = fs.readFileSync(LOCAL_PATH, 'utf8');
      pushData = JSON.parse(data);
      callback(null);
    } catch (err) {
      if (err.code === 'ENOENT') {
        pushData = null;
        callback(null);
      } else {
        callback(err);
      }
    }
  }
}

function save(callback) {
  if (!pushData) { callback(null); return; }
  var json = JSON.stringify(pushData, null, 2);

  if (isS3Enabled()) {
    var config = getS3Config();
    var PutObjectCommand = require('@aws-sdk/client-s3').PutObjectCommand;
    var client = getS3Client();
    var cmd = new PutObjectCommand({
      Bucket: config.bucket,
      Key: S3_KEY,
      Body: json,
      ContentType: 'application/json',
    });
    client.send(cmd).then(function () {
      callback(null);
    }).catch(function (err) {
      callback(err);
    });
  } else {
    var dir = path.dirname(LOCAL_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      var tmpPath = LOCAL_PATH + '.tmp';
      fs.writeFileSync(tmpPath, json);
      fs.renameSync(tmpPath, LOCAL_PATH);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

// ── VAPID key management ──

function ensureWebPush() {
  if (!webpush) {
    webpush = require('web-push');
  }
  return webpush;
}

function ensureVapidKeys(callback) {
  if (pushData && pushData.vapidKeys) {
    callback(null);
    return;
  }
  var wp = ensureWebPush();
  var keys = wp.generateVAPIDKeys();
  if (!pushData) {
    pushData = { vapidKeys: keys, subscriptions: [] };
  } else {
    pushData.vapidKeys = keys;
  }
  save(function (err) {
    if (err) log.error('failed to save VAPID keys', { error: err.message });
    callback(err);
  });
}

function getPublicKey() {
  return pushData && pushData.vapidKeys ? pushData.vapidKeys.publicKey : null;
}

function configureWebPush() {
  if (!pushData || !pushData.vapidKeys) return;
  var wp = ensureWebPush();
  var subject = process.env.VAPID_SUBJECT || process.env.ORIGIN || 'mailto:admin@example.com';
  wp.setVapidDetails(subject, pushData.vapidKeys.publicKey, pushData.vapidKeys.privateKey);
}

// ── Subscription management ──

function addSubscription(subscription, categories, callback) {
  if (!pushData) pushData = { vapidKeys: null, subscriptions: [] };
  if (!pushData.subscriptions) pushData.subscriptions = [];

  // Validate categories
  var validCats = [];
  for (var i = 0; i < categories.length; i++) {
    if (VALID_CATEGORIES.indexOf(categories[i]) >= 0) {
      validCats.push(categories[i]);
    }
  }

  // Check if endpoint already exists — update categories
  var found = false;
  for (var j = 0; j < pushData.subscriptions.length; j++) {
    if (pushData.subscriptions[j].endpoint === subscription.endpoint) {
      pushData.subscriptions[j].keys = subscription.keys;
      pushData.subscriptions[j].categories = validCats;
      found = true;
      break;
    }
  }
  if (!found) {
    pushData.subscriptions.push({
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      categories: validCats,
    });
  }

  save(function (err) {
    if (err) {
      log.error('failed to save subscription', { error: err.message });
      callback(err);
      return;
    }
    log.info('subscription saved', { endpoint: subscription.endpoint.slice(-20), categories: validCats });
    callback(null);
  });
}

function removeSubscription(endpoint, callback) {
  if (!pushData || !pushData.subscriptions) {
    callback(null);
    return;
  }

  var before = pushData.subscriptions.length;
  pushData.subscriptions = pushData.subscriptions.filter(function (s) {
    return s.endpoint !== endpoint;
  });

  if (pushData.subscriptions.length === before) {
    callback(null);
    return;
  }

  save(function (err) {
    if (err) log.error('failed to save after unsubscribe', { error: err.message });
    callback(err);
  });
}

function getSubscription(endpoint) {
  if (!pushData || !pushData.subscriptions) return null;
  for (var i = 0; i < pushData.subscriptions.length; i++) {
    if (pushData.subscriptions[i].endpoint === endpoint) {
      return pushData.subscriptions[i];
    }
  }
  return null;
}

function getSubscriptionCount() {
  return pushData && pushData.subscriptions ? pushData.subscriptions.length : 0;
}

// ── Category icon paths ──
// Each notification category gets its own Material Symbols glyph
// rendered as a PNG by scripts/make-icons.mjs. The SW uses these as
// the `icon` property on showNotification() so the notification tray
// icon matches the alert type.

var CATEGORY_ICONS = {
  evening_report:   'assets/notif-evening.png',
  noon_report:      'assets/notif-noon.png',
  overheat_warning: 'assets/notif-overheat.png',
  freeze_warning:   'assets/notif-freeze.png',
  offline_warning:  'assets/notif-offline.png',
  watchdog_fired:   'assets/notif-watchdog.png',
};

function iconFor(category) {
  return CATEGORY_ICONS[category] || 'assets/icon-192.png';
}

// ── Mock payloads for the "send test notification" feature ──
// Used by /api/push/test so users can preview how each category looks
// without waiting for a real event. Titles are prefixed with "[Test]"
// so the user immediately recognizes them as manually-triggered.

function buildMockPayload(category) {
  if (category === 'evening_report') {
    return {
      title: '[Test] Daily Solar Report',
      body: 'Today your collectors gathered approximately 8.5 kWh (8524 Wh) of thermal energy.',
      tag: 'test-evening-report',
      icon: iconFor(category),
      url: '/#status',
    };
  }
  if (category === 'noon_report') {
    return {
      title: '[Test] Overnight Heating Report',
      body: 'Overnight the greenhouse heating ran for 4h 12min.',
      tag: 'test-noon-report',
      icon: iconFor(category),
      url: '/#status',
    };
  }
  if (category === 'overheat_warning') {
    return {
      title: '[Test] Overheat Warning',
      body: (function () {
        var oh = require('../../shelly/control-logic.js').DEFAULT_CONFIG.overheatDrainTemp;
        return 'Tank temperature is ' + (oh - 2.6).toFixed(1) + '\u00b0C and rising. ' +
               'Overheat drain may activate at ' + oh + '\u00b0C.';
      })(),
      tag: 'test-overheat-warning',
      icon: iconFor(category),
      url: '/#status',
    };
  }
  if (category === 'freeze_warning') {
    return {
      title: '[Test] Freeze Warning',
      body: (function () {
        var fz = require('../../shelly/control-logic.js').DEFAULT_CONFIG.freezeDrainTemp;
        return 'Outdoor temperature is ' + (fz + 0.8).toFixed(1) + '\u00b0C and falling. ' +
               'Freeze drain may activate at ' + fz + '\u00b0C.';
      })(),
      tag: 'test-freeze-warning',
      icon: iconFor(category),
      url: '/#status',
    };
  }
  if (category === 'offline_warning') {
    return {
      title: '[Test] Controller Offline',
      body: 'No data received from the greenhouse controller for 15 minutes.',
      tag: 'test-offline-warning',
      icon: iconFor(category),
      url: '/#status',
    };
  }
  if (category === 'watchdog_fired') {
    // Mirror the real fired-notification shape so the test exercises
    // the inline-reply input and the "Shutdown now" button. Without
    // `actions`, the notification renders bare and the user can't
    // verify whether their device supports inline replies.
    //
    // `data.test: true` is the SW-side short-circuit: tapping snooze
    // or shutdown on a TEST notification must not POST to the real
    // /api/watchdog/* endpoints — there's no pending fire on the
    // server, so the call would 409. Instead, the SW handles the
    // action locally and shows an acknowledgement notification with
    // the user's reply text, mirroring the real ack flow entirely
    // client-side.
    //
    // `snoozeTtlSeconds` and `testLabel` give the SW the metadata it
    // needs to build the local ack notification (for ggr the snooze
    // TTL is 12h per shelly/watchdogs-meta.js).
    return {
      title: '[Test] Watchdog fired \u2014 Greenhouse not warming',
      body: 'Greenhouse only +0.2\u00B0C after 15:00. Auto-shutdown in 5 min.',
      tag: 'test-watchdog-fired',
      icon: iconFor(category),
      badge: 'assets/badge-72.png',
      url: '/#status',
      requireInteraction: true,
      renotify: true,
      actions: [
        { action: 'shutdownnow', type: 'button', title: 'Shutdown now' },
        { action: 'snooze',      type: 'text',   title: 'Snooze',
          placeholder: 'Reason (e.g. door open)' },
      ],
      data: {
        kind: 'watchdog_fired',
        test: true,
        testLabel: 'Greenhouse not warming',
        snoozeTtlSeconds: 43200,
        url: '/#status',
      },
    };
  }
  return null;
}

// Send a one-off notification to a single subscription endpoint, bypassing
// both rate limiting and subscription category filtering. Used only by
// the /api/push/test endpoint so a user can preview how their chosen
// categories render on their own device.
function sendTestToEndpoint(endpoint, payload, callback) {
  if (!pushData || !pushData.subscriptions) {
    callback(new Error('No subscriptions'));
    return;
  }
  var sub = null;
  for (var i = 0; i < pushData.subscriptions.length; i++) {
    if (pushData.subscriptions[i].endpoint === endpoint) {
      sub = pushData.subscriptions[i];
      break;
    }
  }
  if (!sub) {
    callback(new Error('Subscription not found'));
    return;
  }
  var wp = ensureWebPush();
  var pushSub = { endpoint: sub.endpoint, keys: sub.keys };
  wp.sendNotification(pushSub, JSON.stringify(payload)).then(function () {
    log.info('test notification sent', { endpoint: endpoint.slice(-20), tag: payload.tag });
    callback(null);
  }).catch(function (err) {
    log.error('test notification failed', { error: err.message, statusCode: err.statusCode });
    callback(err);
  });
}

// ── Sending notifications ──

function isRateLimited(type) {
  var now = Date.now();
  if (lastSentAt[type] && (now - lastSentAt[type]) < RATE_LIMIT_MS) {
    return true;
  }
  return false;
}

function sendNotification(type, payload) {
  if (!pushData || !pushData.subscriptions || pushData.subscriptions.length === 0) return;
  if (!webpush) return;

  if (isRateLimited(type)) {
    log.info('notification rate-limited', { type: type });
    return;
  }

  lastSentAt[type] = Date.now();

  var expiredEndpoints = [];
  var sent = 0;

  for (var i = 0; i < pushData.subscriptions.length; i++) {
    var sub = pushData.subscriptions[i];
    if (sub.categories.indexOf(type) < 0) continue;

    var pushSub = {
      endpoint: sub.endpoint,
      keys: sub.keys,
    };

    sent++;
    (function (endpoint) {
      webpush.sendNotification(pushSub, JSON.stringify(payload)).catch(function (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          log.info('push subscription expired, removing', { endpoint: endpoint.slice(-20) });
          expiredEndpoints.push(endpoint);
        } else {
          log.error('push send failed', { error: err.message, statusCode: err.statusCode });
        }
      });
    })(sub.endpoint);
  }

  if (sent > 0) {
    log.info('push sent', { type: type, count: sent });
  }

  // Clean up expired subscriptions after a short delay
  if (expiredEndpoints.length > 0) {
    setTimeout(function () {
      var changed = false;
      for (var k = 0; k < expiredEndpoints.length; k++) {
        var before = pushData.subscriptions.length;
        pushData.subscriptions = pushData.subscriptions.filter(function (s) {
          return s.endpoint !== expiredEndpoints[k];
        });
        if (pushData.subscriptions.length < before) changed = true;
      }
      if (changed) {
        save(function (err) {
          if (err) log.error('failed to save after cleanup', { error: err.message });
        });
      }
    }, 1000);
  }
}

// ── Initialization ──

function init(callback) {
  load(function (err) {
    if (err) {
      log.error('failed to load push config', { error: err.message });
      callback(err);
      return;
    }
    ensureVapidKeys(function (err2) {
      if (err2) {
        callback(err2);
        return;
      }
      configureWebPush();
      log.info('push initialized', { subscriptions: getSubscriptionCount() });
      callback(null);
    });
  });
}

// ── Test helpers ──

function _reset() {
  webpush = null;
  s3Client = null;
  s3Config = null;
  pushData = null;
  lastSentAt = {};
}

function _getLastSentAt() {
  return lastSentAt;
}

function _setLastSentAt(map) {
  lastSentAt = map;
}

function _getPushData() {
  return pushData;
}

function _setPushData(data) {
  pushData = data;
}

module.exports = {
  VALID_CATEGORIES: VALID_CATEGORIES,
  RATE_LIMIT_MS: RATE_LIMIT_MS,
  init: init,
  load: load,
  save: save,
  getPublicKey: getPublicKey,
  addSubscription: addSubscription,
  removeSubscription: removeSubscription,
  getSubscription: getSubscription,
  getSubscriptionCount: getSubscriptionCount,
  isRateLimited: isRateLimited,
  sendNotification: sendNotification,
  buildMockPayload: buildMockPayload,
  sendTestToEndpoint: sendTestToEndpoint,
  iconFor: iconFor,
  CATEGORY_ICONS: CATEGORY_ICONS,
  _reset: _reset,
  _getLastSentAt: _getLastSentAt,
  _setLastSentAt: _setLastSentAt,
  _getPushData: _getPushData,
  _setPushData: _setPushData,
};
