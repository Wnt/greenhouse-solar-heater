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
 *
 * Coverage: when COVERAGE=1 is set, the page fixture starts V8 JS
 * coverage at test start and dumps the raw output to
 * `coverage/raw/<testId>.json` at teardown. `npm run coverage:frontend`
 * reads that directory, filters to playground/js/**, and renders an
 * istanbul HTML/lcov/text report. Running without the env var is the
 * default so unit-test-speed Playwright runs stay unchanged.
 */
import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const COVERAGE_ENABLED = process.env.COVERAGE === '1';
const COVERAGE_DIR = path.resolve(process.cwd(), 'coverage/raw');

if (COVERAGE_ENABLED) {
  fs.mkdirSync(COVERAGE_DIR, { recursive: true });
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());

    if (COVERAGE_ENABLED) {
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
    }

    await use(page);

    if (COVERAGE_ENABLED) {
      let entries;
      try {
        entries = await page.coverage.stopJSCoverage();
      } catch {
        // The page may already be closed by the time teardown runs.
        // That's fine — a closed page just means there's nothing to collect.
        return;
      }
      // Keep only scripts served from the playground tree. Anything
      // else (Playwright's injected helpers, vendored libs served under
      // /vendor, inline snippets without a URL) is noise for this report.
      const filtered = entries.filter(e => /\/js\//.test(e.url) && !/\/vendor\//.test(e.url));
      if (filtered.length > 0) {
        const destFile = path.join(COVERAGE_DIR, `${testInfo.testId}.json`);
        fs.writeFileSync(destFile, JSON.stringify(filtered));
      }
    }
  },
});

/**
 * Wait until the playground SPA has finished its async init pipeline
 * (config load, control-logic load, navigation/notification wiring).
 * Tests that click navigation links or buttons whose handlers are
 * attached during init must call this after `page.goto('/playground/...')`
 * to avoid racing with the wire-up — clicks dispatched before then
 * land on inert elements and silently no-op.
 *
 * The signal is `document.body.dataset.ready = '1'`, set in
 * `playground/js/main.js` after `wireNotificationUI()` resolves.
 */
export async function waitForAppReady(page) {
  await expect(page.locator('body[data-ready="1"]')).toBeAttached();
}

export { expect };
