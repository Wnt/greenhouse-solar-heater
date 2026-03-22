/**
 * Unit tests for poc/lib/push-storage.js
 * Tests local filesystem fallback mode (no S3 env vars).
 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var pushStorage = require('../monitor/lib/push-storage');

var TEST_DIR = path.join(__dirname, '.tmp-push-storage-test');

test.beforeEach(function () {
  pushStorage._reset();
  // Clear S3 env vars to force local mode
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_BUCKET;
  delete process.env.S3_ACCESS_KEY_ID;
  delete process.env.S3_SECRET_ACCESS_KEY;
  // Use test directory for local storage
  process.env.PUSH_DATA_DIR = TEST_DIR;
  // Clean up test directory
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
});

test.afterEach(function () {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  delete process.env.PUSH_DATA_DIR;
});

test('loadVapidKeys returns null when no data exists', function (t, done) {
  pushStorage.loadVapidKeys(function (err, data) {
    assert.equal(err, null);
    assert.equal(data, null);
    done();
  });
});

test('saveVapidKeys and loadVapidKeys round-trip data', function (t, done) {
  var keys = { publicKey: 'test-public', privateKey: 'test-private', subject: 'mailto:test@test.com' };
  pushStorage.saveVapidKeys(keys, function (err) {
    assert.equal(err, null);
    pushStorage.loadVapidKeys(function (err2, loaded) {
      assert.equal(err2, null);
      assert.deepEqual(loaded, keys);
      done();
    });
  });
});

test('loadSubscriptions returns empty array when no data exists', function (t, done) {
  pushStorage.loadSubscriptions(function (err, data) {
    assert.equal(err, null);
    assert.deepEqual(data, []);
    done();
  });
});

test('addSubscription appends a new subscription', function (t, done) {
  var sub = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } };
  pushStorage.addSubscription(sub, function (err, existing) {
    assert.equal(err, null);
    assert.equal(existing, false);
    pushStorage.loadSubscriptions(function (err2, subs) {
      assert.equal(err2, null);
      assert.equal(subs.length, 1);
      assert.deepEqual(subs[0], sub);
      done();
    });
  });
});

test('addSubscription deduplicates by endpoint', function (t, done) {
  var sub1 = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } };
  var sub2 = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'c', auth: 'd' } };
  pushStorage.addSubscription(sub1, function (err) {
    assert.equal(err, null);
    pushStorage.addSubscription(sub2, function (err2, existing) {
      assert.equal(err2, null);
      assert.equal(existing, true);
      pushStorage.loadSubscriptions(function (err3, subs) {
        assert.equal(err3, null);
        assert.equal(subs.length, 1);
        assert.deepEqual(subs[0].keys, sub2.keys);
        done();
      });
    });
  });
});

test('removeSubscription removes by endpoint and returns true', function (t, done) {
  var sub1 = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'a', auth: 'b' } };
  var sub2 = { endpoint: 'https://push.example.com/2', keys: { p256dh: 'c', auth: 'd' } };
  pushStorage.addSubscription(sub1, function () {
    pushStorage.addSubscription(sub2, function () {
      pushStorage.removeSubscription('https://push.example.com/1', function (err, removed) {
        assert.equal(err, null);
        assert.equal(removed, true);
        pushStorage.loadSubscriptions(function (err2, subs) {
          assert.equal(err2, null);
          assert.equal(subs.length, 1);
          assert.equal(subs[0].endpoint, 'https://push.example.com/2');
          done();
        });
      });
    });
  });
});

test('removeSubscription returns false when endpoint not found', function (t, done) {
  pushStorage.removeSubscription('https://push.example.com/nonexistent', function (err, removed) {
    assert.equal(err, null);
    assert.equal(removed, false);
    done();
  });
});

test('saveSubscriptions and loadSubscriptions round-trip', function (t, done) {
  var subs = [
    { endpoint: 'https://a.com', keys: { p256dh: '1', auth: '2' } },
    { endpoint: 'https://b.com', keys: { p256dh: '3', auth: '4' } },
  ];
  pushStorage.saveSubscriptions(subs, function (err) {
    assert.equal(err, null);
    pushStorage.loadSubscriptions(function (err2, loaded) {
      assert.equal(err2, null);
      assert.deepEqual(loaded, subs);
      done();
    });
  });
});
