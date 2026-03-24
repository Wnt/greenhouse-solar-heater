import { test, expect } from './fixtures.js';

test.describe('Logout Feature', () => {
  test('logout button is hidden by default when auth status returns 404', async ({ page }) => {
    // Mock /auth/status to return 404 (auth disabled)
    await page.route('**/auth/status', route =>
      route.fulfill({ status: 404, body: 'Not Found' })
    );

    await page.goto('/monitor/');
    // Wait for the auth check to complete
    await page.waitForTimeout(100);
    const logoutBtn = page.locator('#logout-btn');
    await expect(logoutBtn).toBeHidden();
  });

  test('logout button is visible when user is authenticated', async ({ page }) => {
    await page.route('**/auth/status', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, setupMode: false, registrationOpen: true }),
      })
    );

    await page.goto('/monitor/');
    const logoutBtn = page.locator('#logout-btn');
    await expect(logoutBtn).toBeVisible();
    await expect(logoutBtn).toHaveText('Logout');
  });

  test('logout button is hidden when user is not authenticated', async ({ page }) => {
    await page.route('**/auth/status', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: false, setupMode: true, registrationOpen: true }),
      })
    );

    await page.goto('/monitor/');
    // Wait for the auth check to complete
    await page.waitForTimeout(100);
    const logoutBtn = page.locator('#logout-btn');
    await expect(logoutBtn).toBeHidden();
  });

  test('clicking logout calls POST /auth/logout', async ({ page }) => {
    await page.route('**/auth/status', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, setupMode: false, registrationOpen: true }),
      })
    );

    // Track logout request
    const logoutPromise = page.waitForRequest(req =>
      req.url().includes('/auth/logout') && req.method() === 'POST'
    );

    // Mock /auth/logout — fulfill with success
    await page.route('**/auth/logout', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    );

    await page.goto('/monitor/');
    const logoutBtn = page.locator('#logout-btn');
    await expect(logoutBtn).toBeVisible();

    await logoutBtn.click();
    const logoutReq = await logoutPromise;
    expect(logoutReq.method()).toBe('POST');
  });

  test('logout shows error when network fails', async ({ page }) => {
    await page.route('**/auth/status', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, setupMode: false, registrationOpen: true }),
      })
    );

    // Mock /auth/logout to fail
    await page.route('**/auth/logout', route => route.abort('connectionfailed'));

    await page.goto('/monitor/');
    const logoutBtn = page.locator('#logout-btn');
    await expect(logoutBtn).toBeVisible();

    await logoutBtn.click();

    // Should show error in event log
    const eventLog = page.locator('#event-log');
    await expect(eventLog).toContainText('Logout failed', { timeout: 5000 });
  });
});
