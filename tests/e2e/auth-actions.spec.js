// @ts-check
import { test, expect } from './fixtures.js';

/**
 * E2E tests for the Account card (logout + "Add Device" invitation).
 *
 * These controls live inside the Settings view (#view-settings). The
 * playground calls GET /auth/status on init; when authenticated, the
 * Account card (#auth-actions) un-hides. When auth is disabled (404)
 * the card stays hidden.
 */

async function mockAuthenticated(page) {
  await page.route('**/auth/status', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, setupMode: false, registrationOpen: true }),
    })
  );
}

async function mockAuthDisabled(page) {
  await page.route('**/auth/status', route =>
    route.fulfill({ status: 404, body: 'Not Found' })
  );
}

async function mockUnauthenticated(page) {
  await page.route('**/auth/status', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, setupMode: false, registrationOpen: false }),
    })
  );
}

// Navigate into the Settings view where the Account card lives.
async function gotoSettings(page) {
  await page.evaluate(() => { window.location.hash = 'settings'; });
  await expect(page.locator('#view-settings')).toHaveClass(/active/);
}

test.describe('Account actions (logout + Add Device)', () => {
  test('Account card is hidden when auth is disabled (404)', async ({ page }) => {
    await mockAuthDisabled(page);
    await page.goto('/playground/');
    await gotoSettings(page);

    await expect(page.locator('#auth-actions')).toBeHidden();
    await expect(page.locator('#logout-btn')).toBeHidden();
    await expect(page.locator('#invite-btn')).toBeHidden();
  });

  test('Account card is hidden when user is not authenticated', async ({ page }) => {
    await mockUnauthenticated(page);
    await page.goto('/playground/');
    await gotoSettings(page);

    await expect(page.locator('#auth-actions')).toBeHidden();
  });

  test('Account card is visible when user is authenticated', async ({ page }) => {
    await mockAuthenticated(page);
    await page.goto('/playground/');
    await gotoSettings(page);

    await expect(page.locator('#auth-actions')).toBeVisible();
    await expect(page.locator('#logout-btn')).toBeVisible();
    await expect(page.locator('#logout-btn')).toContainText('Logout');
    await expect(page.locator('#invite-btn')).toBeVisible();
    await expect(page.locator('#invite-btn')).toContainText('Add Device');
  });

  test('clicking logout sends POST /auth/logout and redirects to login', async ({ page }) => {
    await mockAuthenticated(page);

    const logoutPromise = page.waitForRequest(req =>
      req.url().includes('/auth/logout') && req.method() === 'POST'
    );
    await page.route('**/auth/logout', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    );
    await page.route('**/login.html', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>login</body></html>' })
    );

    await page.goto('/playground/');
    await gotoSettings(page);
    await page.locator('#logout-btn').click();

    const req = await logoutPromise;
    expect(req.method()).toBe('POST');

    await page.waitForURL(/\/login\.html$/, { timeout: 5000 });
  });

  test('clicking Add Device opens modal with code, QR, and timer', async ({ page }) => {
    await mockAuthenticated(page);
    await page.route('**/auth/invite/create', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: '123456', expiresInSeconds: 300 }),
      })
    );

    await page.goto('/playground/');
    await gotoSettings(page);
    await page.locator('#invite-btn').click();

    const modal = page.locator('#invite-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#invite-code')).toHaveText('123456');
    await expect(page.locator('#invite-timer')).toContainText('Expires in');

    const qrSize = await page.locator('#invite-qr').evaluate((el) => ({
      w: /** @type {HTMLCanvasElement} */ (el).width,
      h: /** @type {HTMLCanvasElement} */ (el).height,
    }));
    expect(qrSize.w).toBeGreaterThan(0);
    expect(qrSize.h).toBeGreaterThan(0);
  });

  test('closing invite modal hides it', async ({ page }) => {
    await mockAuthenticated(page);
    await page.route('**/auth/invite/create', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: '654321', expiresInSeconds: 300 }),
      })
    );

    await page.goto('/playground/');
    await gotoSettings(page);
    await page.locator('#invite-btn').click();
    await expect(page.locator('#invite-modal')).toBeVisible();

    await page.locator('#invite-close-btn').click();
    await expect(page.locator('#invite-modal')).toBeHidden();
  });

  test('invite creation shows error on failure', async ({ page }) => {
    await mockAuthenticated(page);
    await page.route('**/auth/invite/create', route =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not authenticated' }),
      })
    );

    await page.goto('/playground/');
    await gotoSettings(page);
    await page.locator('#invite-btn').click();

    const err = page.locator('#invite-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText('Not authenticated');
  });
});
