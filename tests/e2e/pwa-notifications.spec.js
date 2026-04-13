/**
 * E2E tests for the Settings view: PWA install, push notifications,
 * and related fallbacks.
 *
 * The Settings view is where the Install App button, notification
 * toggle, and account controls live. It's reachable via the sidebar
 * (desktop) and bottom nav (mobile).
 *
 * Regressions covered:
 *   - Button labels must not destroy icon spans when toggled
 *     (setBtnLabel updates a .auth-btn-label span only)
 *   - Install button must be visible by default on desktop
 *   - Notification toggle must show both icon and label
 *   - Clicking install shows the native prompt (if captured) or the
 *     instructions modal fallback (for Safari/Firefox)
 *   - Mobile viewport: Settings is reachable from bottom nav and
 *     the buttons are visible and clickable without obstructing
 *     main content on other views
 */

import { test, expect } from './fixtures.js';

// The Playwright test server serves static files via `npx serve` and has
// no /api/push/vapid-key endpoint, so we mock it with a valid-looking key.
// Similarly /sw.js will 404 from the static server unless we stub it.
async function mockPushApi(page) {
  await page.route('**/api/push/vapid-key', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        publicKey: 'BIlDax-DYNzPJfB4LHkOfn_nnpU1i_-27xp9UHUZS-axEePU-xIB94H4vblRxEJxjR-k-SK70o-mpQoMy2QcZUA',
      }),
    });
  });
  await page.route('**/sw.js', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: 'self.addEventListener("install", () => self.skipWaiting());',
    });
  });
}

async function gotoSettings(page) {
  // Navigate to the Settings view (URL hash based routing)
  await page.evaluate(() => { window.location.hash = 'settings'; });
  await expect(page.locator('#view-settings')).toHaveClass(/active/);
  // Wait for async init (VAPID fetch + updateNotificationUI) to set labels
  await page.waitForFunction(() => {
    const lbl = document.querySelector('#notif-toggle-btn .auth-btn-label');
    return lbl && lbl.textContent && lbl.textContent.length > 0;
  }, { timeout: 3000 }).catch(() => {});
}

test.describe('Settings view — desktop', () => {
  test.beforeEach(async ({ page }) => {
    await mockPushApi(page);
    await page.goto('/playground/?mode=sim');
    await expect(page.locator('#fab-play')).toBeVisible();
    await gotoSettings(page);
  });

  test('Settings nav item is visible in sidebar', async ({ page }) => {
    const navLink = page.locator('.sidebar-nav [data-view="settings"]');
    await expect(navLink).toBeVisible();
  });

  test('install button is visible inside the Settings view', async ({ page }) => {
    const btn = page.locator('#view-settings #pwa-install-btn');
    await expect(btn).toBeVisible();
    await expect(btn.locator('.material-symbols-outlined')).toBeVisible();
    await expect(btn.locator('.auth-btn-label')).toHaveText('Install App');
  });

  test('notification toggle is visible with icon and label', async ({ page }) => {
    const btn = page.locator('#view-settings #notif-toggle-btn');
    await expect(btn).toBeVisible();
    await expect(btn.locator('.material-symbols-outlined')).toBeVisible();
    const labelText = await btn.locator('.auth-btn-label').textContent();
    expect(labelText).toBeTruthy();
    expect(labelText.trim().length).toBeGreaterThan(0);
  });

  test('notification toggle label mentions notifications', async ({ page }) => {
    const labelText = await page.locator('#notif-toggle-btn .auth-btn-label').textContent();
    expect(labelText.toLowerCase()).toMatch(/notifications|enable|subscribe/);
  });

  test('notification toggle icon survives async init', async ({ page }) => {
    // Regression: textContent was destroying the icon span
    const iconCount = await page.locator('#notif-toggle-btn .material-symbols-outlined').count();
    expect(iconCount).toBe(1);
  });

  test('clicking install shows the fallback instructions modal', async ({ page }) => {
    await page.locator('#pwa-install-btn').click();
    const modal = page.locator('#install-modal');
    await expect(modal).toBeVisible();
    const instructions = await page.locator('#install-instructions').textContent();
    expect(instructions.length).toBeGreaterThan(10);
  });

  test('install modal closes via close button', async ({ page }) => {
    await page.locator('#pwa-install-btn').click();
    await expect(page.locator('#install-modal')).toBeVisible();
    await page.locator('#install-close-btn').click();
    await expect(page.locator('#install-modal')).toBeHidden();
  });

  test('install modal closes via backdrop click', async ({ page }) => {
    await page.locator('#pwa-install-btn').click();
    await expect(page.locator('#install-modal')).toBeVisible();
    await page.locator('#install-modal-backdrop').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#install-modal')).toBeHidden();
  });

  test('category checkboxes are hidden until subscribed', async ({ page }) => {
    await expect(page.locator('#notif-categories')).toBeHidden();
  });

  test('all five notification category checkboxes exist', async ({ page }) => {
    const ids = [
      'notif-cat-evening_report',
      'notif-cat-noon_report',
      'notif-cat-overheat_warning',
      'notif-cat-freeze_warning',
      'notif-cat-offline_warning',
    ];
    for (const id of ids) {
      await expect(page.locator('#' + id)).toHaveCount(1);
    }
  });

  test('a test button exists for each of the five categories', async ({ page }) => {
    const cats = [
      'evening_report',
      'noon_report',
      'overheat_warning',
      'freeze_warning',
      'offline_warning',
    ];
    for (const cat of cats) {
      const btn = page.locator('[data-test-category="' + cat + '"]');
      await expect(btn).toHaveCount(1);
      await expect(btn.locator('.material-symbols-outlined')).toHaveText('send');
    }
  });
});

test.describe('Install card state when running standalone', () => {
  // When the PWA is launched from the home screen Chrome reports
  // display-mode: standalone. The Install card should swap to an
  // "already installed" variant with uninstall instructions and hide
  // the install button entirely.

  test('idle card is shown by default (browser mode)', async ({ page }) => {
    await mockPushApi(page);
    await page.goto('/playground/?mode=sim');
    await expect(page.locator('#fab-play')).toBeVisible();
    await page.evaluate(() => { window.location.hash = 'settings'; });
    await expect(page.locator('#view-settings')).toHaveClass(/active/);

    await expect(page.locator('#pwa-install-idle')).toBeVisible();
    await expect(page.locator('#pwa-install-standalone')).toBeHidden();
    await expect(page.locator('#pwa-install-btn')).toBeVisible();
  });

  test('standalone card is shown when display-mode is standalone', async ({ page }) => {
    // Emulate PWA launch context BEFORE navigation so the
    // matchMedia('(display-mode: standalone)') check on page load
    // sees standalone and swaps the card.
    await page.emulateMedia({ media: 'screen', colorScheme: 'dark' });
    await page.addInitScript(() => {
      const orig = window.matchMedia.bind(window);
      window.matchMedia = function (q) {
        if (typeof q === 'string' && q.indexOf('display-mode: standalone') !== -1) {
          return {
            matches: true,
            media: q,
            onchange: null,
            addListener: function () {},
            removeListener: function () {},
            addEventListener: function () {},
            removeEventListener: function () {},
            dispatchEvent: function () { return true; },
          };
        }
        return orig(q);
      };
    });

    await mockPushApi(page);
    await page.goto('/playground/?mode=sim');
    await expect(page.locator('#fab-play')).toBeVisible();
    await page.evaluate(() => { window.location.hash = 'settings'; });
    await expect(page.locator('#view-settings')).toHaveClass(/active/);

    await expect(page.locator('#pwa-install-idle')).toBeHidden();
    await expect(page.locator('#pwa-install-standalone')).toBeVisible();
    await expect(page.locator('#pwa-install-btn')).toBeHidden();
  });

  test('standalone card contains platform-specific uninstall guidance', async ({ page }) => {
    // Force standalone AND pretend to be Android Chrome for the UA branch
    await page.addInitScript(() => {
      const orig = window.matchMedia.bind(window);
      window.matchMedia = function (q) {
        if (typeof q === 'string' && q.indexOf('display-mode: standalone') !== -1) {
          return { matches: true, media: q, onchange: null,
            addListener: function () {}, removeListener: function () {},
            addEventListener: function () {}, removeEventListener: function () {},
            dispatchEvent: function () { return true; } };
        }
        return orig(q);
      };
      Object.defineProperty(navigator, 'userAgent', {
        get: function () {
          return 'Mozilla/5.0 (Linux; Android 14; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36';
        },
      });
    });

    await mockPushApi(page);
    await page.goto('/playground/?mode=sim');
    await expect(page.locator('#fab-play')).toBeVisible();
    await page.evaluate(() => { window.location.hash = 'settings'; });

    const desc = page.locator('#pwa-uninstall-desc');
    await expect(desc).toBeVisible();
    const text = await desc.textContent();
    // Should mention uninstall steps relevant to Android
    expect(text.toLowerCase()).toMatch(/uninstall|remove/);
    expect(text.toLowerCase()).toMatch(/long-press|settings|home screen/);
  });
});

test.describe('PWA installability criteria', () => {
  // These tests verify the static assets needed for Chrome to actually
  // fire `beforeinstallprompt` on Android. Without a PNG icon and a
  // service worker with a fetch handler, the browser silently refuses
  // to show the install prompt and users only see our fallback modal.

  test('manifest declares at least one PNG icon with size 192 or 512', async ({ page }) => {
    const res = await page.request.get('/playground/manifest.webmanifest');
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    expect(Array.isArray(manifest.icons)).toBe(true);
    const pngIcon = manifest.icons.find(i =>
      i.type === 'image/png' &&
      /(^|[^0-9])(192|512)([^0-9]|$)/.test(i.sizes || '')
    );
    expect(pngIcon, 'manifest must include at least one PNG 192 or 512').toBeTruthy();
  });

  test('manifest has standalone display and start_url', async ({ page }) => {
    const res = await page.request.get('/playground/manifest.webmanifest');
    const manifest = await res.json();
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.name).toBeTruthy();
  });

  test('PNG icons are served with image/png content-type', async ({ page }) => {
    for (const size of [192, 512]) {
      const res = await page.request.get(`/playground/assets/icon-${size}.png`);
      expect(res.ok(), `/playground/assets/icon-${size}.png must exist`).toBe(true);
      const body = await res.body();
      // PNG magic bytes: 89 50 4E 47
      expect(body[0]).toBe(0x89);
      expect(body[1]).toBe(0x50);
      expect(body[2]).toBe(0x4e);
      expect(body[3]).toBe(0x47);
    }
  });

  test('service worker has a fetch event handler', async ({ page }) => {
    const res = await page.request.get('/playground/sw.js');
    expect(res.ok()).toBe(true);
    const body = await res.text();
    // Chrome requires a `fetch` event listener on the SW for install
    expect(body).toMatch(/addEventListener\s*\(\s*['"]fetch['"]/);
  });

  test('service worker uses badge-72.png as badge icon', async ({ page }) => {
    // The Android status-bar badge MUST be a monochrome transparent PNG.
    // If we pass the opaque app icon as badge, Android masks the whole
    // rectangle white and users see a blank white square next to the
    // clock. Regression guard for that specific symptom.
    const res = await page.request.get('/playground/sw.js');
    const body = await res.text();
    expect(body).toMatch(/badge:\s*['"]assets\/badge-72\.png['"]/);
  });

  test('service worker reads icon from push payload data', async ({ page }) => {
    // The SW should use data.icon when present so the server can pick a
    // per-category glyph instead of the generic app icon.
    const res = await page.request.get('/playground/sw.js');
    const body = await res.text();
    expect(body).toMatch(/data\.icon/);
  });

  test('index.html links to the manifest', async ({ page }) => {
    await page.goto('/playground/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toMatch(/manifest\.webmanifest$/);
  });
});

test.describe('Settings view — mobile viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await mockPushApi(page);
    await page.goto('/playground/?mode=sim');
    await expect(page.locator('#fab-play')).toBeVisible();
  });

  test('Settings nav item is visible in mobile bottom nav', async ({ page }) => {
    const navLink = page.locator('.bottom-nav [data-view="settings"]');
    await expect(navLink).toBeVisible();
  });

  test('Settings nav is reachable by tapping the bottom nav', async ({ page }) => {
    await page.locator('.bottom-nav [data-view="settings"]').click();
    await expect(page.locator('#view-settings')).toHaveClass(/active/);
    // Buttons must be visible and clickable (no obstruction)
    const installBtn = page.locator('#view-settings #pwa-install-btn');
    await expect(installBtn).toBeVisible();
    await expect(installBtn.locator('.material-symbols-outlined')).toBeVisible();
    await expect(installBtn.locator('.auth-btn-label')).toBeVisible();
  });

  test('notification toggle is fully visible in Settings view on mobile', async ({ page }) => {
    await gotoSettings(page);
    const btn = page.locator('#view-settings #notif-toggle-btn');
    await expect(btn).toBeVisible();
    await expect(btn.locator('.material-symbols-outlined')).toBeVisible();
    await expect(btn.locator('.auth-btn-label')).toBeVisible();
    const box = await btn.boundingBox();
    expect(box.height).toBeGreaterThan(30);
  });

  test('other views do not have floating PWA buttons obscuring content', async ({ page }) => {
    // Regression: the previous implementation had floating #pwa-actions
    // pinned to the viewport on every view. Verify it's gone.
    await expect(page.locator('#pwa-actions')).toHaveCount(0);
  });

  test('Settings view opens without hiding the Status view header on navigation back', async ({ page }) => {
    await page.locator('.bottom-nav [data-view="settings"]').click();
    await expect(page.locator('#view-settings')).toHaveClass(/active/);
    await page.locator('.bottom-nav [data-view="status"]').click();
    await expect(page.locator('#view-status')).toHaveClass(/active/);
    // Status mode card should be visible again
    await expect(page.locator('#mode-card-title')).toBeVisible();
  });
});
