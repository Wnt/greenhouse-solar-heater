/**
 * Shared Playwright fixtures for all e2e tests.
 *
 * Extends the base `page` fixture to block external font requests
 * (Google Fonts) so page load events fire immediately in
 * restricted/offline environments (CI, Claude Code web runtime).
 *
 * Usage: import { test, expect } from './fixtures.js' instead of
 * from '@playwright/test'.
 */
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
  page: async ({ page }, use) => {
    // Block Google Fonts — prevents page load hanging in offline environments
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    await use(page);
  },
});

export { expect };
