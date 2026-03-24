import { test, expect } from './fixtures.js';

test.describe('PoC Login Page', () => {
  test('loads without JavaScript errors', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    await page.goto('/monitor/login.html', { waitUntil: 'load' });

    // If simplewebauthn module fails to load, we get a JS error
    // instead of the graceful "browser does not support" message
    expect(jsErrors).toEqual([]);
  });

  test('shows error message (module loaded correctly)', async ({ page }) => {
    await page.goto('/monitor/login.html', { waitUntil: 'load' });

    // Without a backend, checkStatus() fails with a fetch error.
    // The key assertion is that the error is a *handled* message in the
    // error div — not an uncaught JS exception. This proves the
    // simplewebauthn module loaded and browserSupportsWebAuthn() ran
    // successfully (test 1 checks for zero JS errors).
    const errorEl = page.locator('#login-error');
    await expect(errorEl).toBeVisible();
    // Either "does not support passkeys" (WebAuthn check) or
    // "Cannot reach server" (fetch to /auth/status fails) — both are
    // graceful handled errors, not module load failures.
    const text = await errorEl.textContent();
    const isHandledError =
      text.includes('does not support passkeys') ||
      text.includes('Cannot reach server');
    expect(isHandledError).toBe(true);
  });

  test('login and register buttons are present', async ({ page }) => {
    await page.goto('/monitor/login.html', { waitUntil: 'load' });

    await expect(page.locator('#login-btn')).toBeAttached();
    await expect(page.locator('#register-btn')).toBeAttached();
  });
});
