/**
 * Shared Playwright fixtures for tests/frontend/ — the playground
 * UI suite that runs against a static file server with API calls
 * mocked via page.route(). Blocks external font requests (Google
 * Fonts) so page load events fire immediately in restricted/offline
 * environments (CI, Claude Code web runtime).
 *
 * Usage: import { test, expect } from './fixtures.js' instead of
 * from '@playwright/test'.
 *
 * See tests/e2e/fixtures.js for the sibling suite that runs against
 * a real server + aedes + pg-mem.
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
