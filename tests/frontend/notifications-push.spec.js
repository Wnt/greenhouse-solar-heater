import { test, expect } from './fixtures.js';

// Drives the push-subscription paths in playground/js/notifications.js
// that pwa-notifications.spec.js doesn't reach: subscribePush,
// updateCategories, sendTest, unsubscribePush, updateNotificationUI,
// updateCategoryCheckboxes, getSelectedCategories, isSubscribed, plus
// urlBase64ToUint8Array + encodeKey.
//
// Why this needs a separate spec: those branches require a working
// ServiceWorker + PushManager + Notification.requestPermission. The
// existing settings specs assume (correctly) that Playwright's
// Chromium can't actually register push subscriptions against a
// static server, so they stop at UI-only assertions. Here we fake
// the browser APIs via addInitScript so the real notifications.js
// code runs end-to-end against the mocks.

async function installPushMocks(page) {
  await page.addInitScript(() => {
    // Fake ServiceWorker registration + PushManager. The real
    // navigator.serviceWorker is inert against a static file server,
    // so we replace it wholesale with an object the code can drive.
    const fakeKey = (label) => {
      const bytes = new TextEncoder().encode(label);
      return bytes.buffer;
    };
    let fakeSubscription = null;
    const pushManager = {
      async subscribe(opts) {
        fakeSubscription = {
          endpoint: 'https://fcm.example/' + Math.random().toString(36).slice(2),
          options: opts,
          _keys: { p256dh: fakeKey('p256dh-fake'), auth: fakeKey('auth-fake') },
          getKey(name) { return this._keys[name]; },
          async unsubscribe() { fakeSubscription = null; return true; },
        };
        return fakeSubscription;
      },
      async getSubscription() { return fakeSubscription; },
    };
    const fakeRegistration = {
      pushManager,
      scope: '/',
      active: { state: 'activated' },
      addEventListener() {},
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: async () => fakeRegistration,
        ready: Promise.resolve(fakeRegistration),
        controller: null,
        addEventListener() {},
      },
    });
    // initNotifications checks `'PushManager' in window`. Add a stub
    // constructor so the feature-detect passes; notifications.js only
    // uses PushManager indirectly via swRegistration.pushManager.
    if (!('PushManager' in window)) {
      window.PushManager = function PushManager() {};
    }
    // Force the permission grant without the native prompt.
    try {
      Object.defineProperty(window.Notification, 'permission', { value: 'granted', configurable: true });
      window.Notification.requestPermission = async () => 'granted';
    } catch (_) {
      // Some browsers ship a sealed Notification — fall back to a shim.
      window.Notification = function () {};
      window.Notification.permission = 'granted';
      window.Notification.requestPermission = async () => 'granted';
    }
  });

  // Track every /api/push/* request so tests can assert what fired.
  const calls = [];

  // Use RegExp with $ anchors so `.../subscribe` doesn't accidentally
  // match `.../subscription` — Playwright's glob `**/foo` is a prefix
  // match on the final segment, which silently routed syncCategories'
  // POST-to-/api/push/subscription into the /api/push/subscribe handler.
  await page.route(/\/api\/push\/vapid-key$/, route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ publicKey: 'BIlDax-DYNzPJfB4LHkOfn_nnpU1i_-27xp9UHUZS-axEePU-xIB94H4vblRxEJxjR-k-SK70o-mpQoMy2QcZUA' }),
  }));
  await page.route(/\/sw\.js$/, route => route.fulfill({
    status: 200, contentType: 'application/javascript',
    body: 'self.addEventListener("install", () => self.skipWaiting());',
  }));
  await page.route(/\/api\/push\/subscription$/, async route => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (_) { /* no body */ }
    calls.push({ url: '/api/push/subscription', body });
    route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ subscribed: true, categories: ['pre_emergency'] }),
    });
  });
  await page.route(/\/api\/push\/subscribe$/, async route => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (_) { /* no body */ }
    calls.push({ url: '/api/push/subscribe', body });
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/push\/unsubscribe$/, async route => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (_) { /* no body */ }
    calls.push({ url: '/api/push/unsubscribe', body });
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route(/\/api\/push\/test$/, async route => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch (_) { /* no body */ }
    calls.push({ url: '/api/push/test', body });
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  return { calls };
}

async function gotoSettings(page) {
  // Hashchange listener is wired inside async init(); see auth-actions.spec.js.
  await page.waitForFunction(() => window.__initComplete === true);
  await page.evaluate(() => { window.location.hash = 'settings'; });
  await expect(page.locator('#view-settings')).toHaveClass(/active/);
  // Wait for initNotifications to settle — the toggle button gets its
  // label set once VAPID is loaded and categories are synced.
  await page.waitForFunction(() => {
    const btn = document.querySelector('#notif-toggle-btn');
    return btn && !btn.disabled;
  }, { timeout: 5000 }).catch(() => {});
}

test.describe('notifications.js push subscription flow', () => {
  test('clicking the toggle subscribes and POSTs /api/push/subscribe', async ({ page }) => {
    const { calls } = await installPushMocks(page);
    await page.goto('/playground/?mode=sim', { waitUntil: 'domcontentloaded' });
    await gotoSettings(page);

    const toggle = page.locator('#notif-toggle-btn');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toHaveClass(/notif-active/);

    await toggle.click();

    // After the subscribe round-trip resolves the button gains the
    // active class and the label changes — this exercises
    // updateNotificationUI().
    await expect(toggle).toHaveClass(/notif-active/, { timeout: 5000 });
    await expect(toggle.locator('.auth-btn-label')).toContainText(/disable/i);

    // Backend saw a subscribe call with endpoint + keys + categories.
    const subscribeCall = calls.find(c => c.url === '/api/push/subscribe');
    expect(subscribeCall).toBeTruthy();
    expect(subscribeCall.body.subscription.endpoint).toMatch(/^https:\/\/fcm\.example\//);
    expect(subscribeCall.body.subscription.keys.p256dh).toBeTruthy();
    expect(subscribeCall.body.subscription.keys.auth).toBeTruthy();
    expect(Array.isArray(subscribeCall.body.categories)).toBe(true);
  });

  test('toggling a category after subscribing PATCHes via /api/push/subscribe', async ({ page }) => {
    const { calls } = await installPushMocks(page);
    await page.goto('/playground/?mode=sim', { waitUntil: 'domcontentloaded' });
    await gotoSettings(page);

    await page.locator('#notif-toggle-btn').click();
    await expect(page.locator('#notif-toggle-btn')).toHaveClass(/notif-active/, { timeout: 5000 });
    calls.length = 0;

    // Toggle the first category checkbox — updateCategories should fire.
    const firstCat = page.locator('[id^="notif-cat-"]').first();
    await firstCat.click();

    await expect.poll(() => calls.find(c => c.url === '/api/push/subscribe')).toBeTruthy();
    const call = calls.find(c => c.url === '/api/push/subscribe');
    expect(Array.isArray(call.body.categories)).toBe(true);
  });

  test('Send test button calls /api/push/test for the clicked category', async ({ page }) => {
    const { calls } = await installPushMocks(page);
    await page.goto('/playground/?mode=sim', { waitUntil: 'domcontentloaded' });
    await gotoSettings(page);

    await page.locator('#notif-toggle-btn').click();
    await expect(page.locator('#notif-toggle-btn')).toHaveClass(/notif-active/, { timeout: 5000 });
    calls.length = 0;

    const testBtn = page.locator('[data-test-category]').first();
    const category = await testBtn.getAttribute('data-test-category');
    await testBtn.click();

    await expect.poll(() => calls.find(c => c.url === '/api/push/test')).toBeTruthy();
    const call = calls.find(c => c.url === '/api/push/test');
    expect(call.body.category).toBe(category);
    expect(call.body.endpoint).toMatch(/^https:\/\/fcm\.example\//);
  });

  test('clicking the toggle again unsubscribes and POSTs /api/push/unsubscribe', async ({ page }) => {
    const { calls } = await installPushMocks(page);
    await page.goto('/playground/?mode=sim', { waitUntil: 'domcontentloaded' });
    await gotoSettings(page);

    const toggle = page.locator('#notif-toggle-btn');
    await toggle.click();
    await expect(toggle).toHaveClass(/notif-active/, { timeout: 5000 });
    calls.length = 0;

    await toggle.click();
    // After unsubscribe the active class is gone and the label flips back.
    await expect(toggle).not.toHaveClass(/notif-active/, { timeout: 5000 });
    await expect(toggle.locator('.auth-btn-label')).toContainText(/enable/i);

    const unsubCall = calls.find(c => c.url === '/api/push/unsubscribe');
    expect(unsubCall).toBeTruthy();
    expect(unsubCall.body.endpoint).toMatch(/^https:\/\/fcm\.example\//);
  });
});
