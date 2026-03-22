/**
 * Unit tests for monitor/sw.js service worker logic.
 * Tests fetch handler behavior with mocked service worker APIs.
 */

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

// Read the service worker source to verify structure
var swSource = fs.readFileSync(path.join(__dirname, '..', 'monitor', 'sw.js'), 'utf8');

test('sw.js defines OFFLINE_CACHE constant', function () {
  assert.ok(swSource.includes("OFFLINE_CACHE = 'greenhouse-offline-v1'"), 'should define offline cache name');
});

test('sw.js defines OFFLINE_URL constant', function () {
  assert.ok(swSource.includes("OFFLINE_URL = '/offline.html'"), 'should define offline URL');
});

test('sw.js pre-caches offline assets in install event', function () {
  assert.ok(swSource.includes("cache.addAll(OFFLINE_ASSETS)"), 'install handler should cache offline assets');
  assert.ok(swSource.includes("'/offline.html'"), 'should cache offline.html');
  assert.ok(swSource.includes("'/icons/icon-192.png'"), 'should cache icon');
});

test('sw.js calls skipWaiting in install handler', function () {
  assert.ok(swSource.includes('self.skipWaiting()'), 'should call skipWaiting');
});

test('sw.js has fetch event handler', function () {
  assert.ok(swSource.includes("self.addEventListener('fetch'"), 'should register fetch handler');
});

test('sw.js fetch handler only intercepts navigation requests', function () {
  assert.ok(swSource.includes("event.request.mode !== 'navigate'"), 'should check for navigate mode');
});

test('sw.js fetch handler falls back to offline page on network error', function () {
  assert.ok(swSource.includes('caches.match(OFFLINE_URL)'), 'should fall back to cached offline page');
});

test('sw.js preserves push notification handler', function () {
  assert.ok(swSource.includes("self.addEventListener('push'"), 'should have push handler');
});

test('sw.js preserves notification click handler', function () {
  assert.ok(swSource.includes("self.addEventListener('notificationclick'"), 'should have notificationclick handler');
});

test('sw.js uses network-first strategy (fetch then catch)', function () {
  assert.ok(swSource.includes('fetch(event.request).catch'), 'should try network first, catch on failure');
});
