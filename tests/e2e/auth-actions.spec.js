// @ts-check
import { test, expect } from './fixtures.js';

/**
 * E2E tests for the Account card (logout + "Invite User" invitation).
 *
 * These controls live inside the Settings view (#view-settings). The
 * playground calls GET /auth/status on init; when authenticated, the
 * Account card (#auth-actions) un-hides. When auth is disabled (404)
 * the card stays hidden.
 */

async function mockAuthenticated(page, role = 'admin') {
  await page.route('**/auth/status', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, setupMode: false, registrationOpen: true, role, name: role === 'admin' ? 'alice' : 'bob' }),
    })
  );
  // Stub the users list so the admin-only Users card renders without errors.
  await page.route('**/auth/users', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ users: [{ id: 'u1', name: 'alice', role: 'admin', credentialCount: 1, isCurrent: role === 'admin' }] }),
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
    await expect(page.locator('#invite-btn')).toContainText('Invite User');
  });

  test('read-only user sees only logout in the Account card', async ({ page }) => {
    await mockAuthenticated(page, 'readonly');
    await page.goto('/playground/');
    await gotoSettings(page);

    await expect(page.locator('#auth-actions')).toBeVisible();
    await expect(page.locator('#logout-btn')).toBeVisible();
    await expect(page.locator('#invite-btn')).toBeHidden();
    await expect(page.locator('#users-card')).toBeHidden();
  });

  test('read-only user does not see Controls or Device nav items', async ({ page }) => {
    await mockAuthenticated(page, 'readonly');
    await page.goto('/playground/');

    // Sidebar nav links for admin-only views are hidden by the
    // body[data-role="readonly"] CSS rule + JS subscriptions.
    await expect(page.locator('.sidebar-nav a[data-view="controls"]')).toBeHidden();
    await expect(page.locator('.sidebar-nav a[data-view="device"]')).toBeHidden();
    await expect(page.locator('.bottom-nav a[data-view="controls"]')).toBeHidden();
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

  test('clicking Invite User opens form, then submits and shows code, QR, timer', async ({ page }) => {
    await mockAuthenticated(page);
    await page.route('**/auth/invite/create', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: '123456', expiresInSeconds: 300, role: 'readonly', name: 'eve' }),
      })
    );

    await page.goto('/playground/');
    await gotoSettings(page);
    await page.locator('#invite-btn').click();

    const modal = page.locator('#invite-modal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#invite-form')).toBeVisible();
    await expect(page.locator('#invite-result')).toBeHidden();

    await page.locator('#invite-name-input').fill('eve');
    await page.locator('#invite-role-select').selectOption('readonly');
    await page.locator('#invite-create-btn').click();

    await expect(page.locator('#invite-form')).toBeHidden();
    await expect(page.locator('#invite-result')).toBeVisible();
    await expect(page.locator('#invite-code')).toHaveText('123456');
    await expect(page.locator('#invite-timer')).toContainText('Expires in');
    await expect(page.locator('#invite-summary')).toContainText('read-only');

    const qrSize = await page.locator('#invite-qr').evaluate((el) => ({
      w: /** @type {HTMLCanvasElement} */ (el).width,
      h: /** @type {HTMLCanvasElement} */ (el).height,
    }));
    expect(qrSize.w).toBeGreaterThan(0);
    expect(qrSize.h).toBeGreaterThan(0);
  });

  test('closing invite modal hides it', async ({ page }) => {
    await mockAuthenticated(page);

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
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'A user with that name already exists' }),
      })
    );

    await page.goto('/playground/');
    await gotoSettings(page);
    await page.locator('#invite-btn').click();
    await page.locator('#invite-name-input').fill('eve');
    await page.locator('#invite-create-btn').click();

    const err = page.locator('#invite-error');
    await expect(err).toBeVisible();
    await expect(err).toContainText('already exists');
  });

  test('user management list supports rename via PATCH', async ({ page }) => {
    await page.route('**/auth/status', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, setupMode: false, registrationOpen: true, role: 'admin', name: 'alice' }),
      })
    );
    let usersResponses = [
      { users: [
        { id: 'u1', name: 'alice', role: 'admin', credentialCount: 1, isCurrent: true },
        { id: 'u2', name: 'bob', role: 'readonly', credentialCount: 1, isCurrent: false },
      ] },
      { users: [
        { id: 'u1', name: 'alice', role: 'admin', credentialCount: 1, isCurrent: true },
        { id: 'u2', name: 'bobby', role: 'readonly', credentialCount: 1, isCurrent: false },
      ] },
    ];
    let callIdx = 0;
    await page.route('**/auth/users', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(usersResponses[Math.min(callIdx++, usersResponses.length - 1)]),
      })
    );
    const patchPromise = page.waitForRequest(req =>
      req.url().includes('/auth/users/u2') && req.method() === 'PATCH'
    );
    await page.route('**/auth/users/u2', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, user: { id: 'u2', name: 'bobby', role: 'readonly' } }),
      })
    );

    await page.goto('/playground/');
    await gotoSettings(page);

    const list = page.locator('#users-list');
    await expect(list).toContainText('bob');

    // Stub window.prompt to return the new name without UI interaction
    await page.evaluate(() => { window.prompt = () => 'bobby'; });
    await list.locator('.user-edit-btn').nth(1).click();

    const req = await patchPromise;
    expect(JSON.parse(req.postData() || '{}')).toEqual({ name: 'bobby' });

    await expect(list).toContainText('bobby', { timeout: 5000 });
  });

  test('user management list renders and supports delete', async ({ page }) => {
    await page.route('**/auth/status', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, setupMode: false, registrationOpen: true, role: 'admin', name: 'alice' }),
      })
    );
    let usersResponses = [
      { users: [
        { id: 'u1', name: 'alice', role: 'admin', credentialCount: 1, isCurrent: true },
        { id: 'u2', name: 'bob', role: 'readonly', credentialCount: 1, isCurrent: false },
      ] },
      { users: [
        { id: 'u1', name: 'alice', role: 'admin', credentialCount: 1, isCurrent: true },
      ] },
    ];
    let callIdx = 0;
    await page.route('**/auth/users', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(usersResponses[Math.min(callIdx++, usersResponses.length - 1)]),
      })
    );
    await page.route('**/auth/users/u2', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      })
    );

    await page.goto('/playground/');
    await gotoSettings(page);

    const list = page.locator('#users-list');
    await expect(list).toContainText('alice');
    await expect(list).toContainText('bob');
    await expect(list.locator('.user-role-admin').first()).toHaveText('Admin');
    await expect(list.locator('.user-role-readonly').first()).toHaveText('Read-only');

    // Stub the confirm dialog so the click proceeds without user interaction
    page.on('dialog', d => d.accept());
    await list.locator('.user-delete-btn').first().click();

    await expect(list).not.toContainText('bob', { timeout: 5000 });
  });
});
