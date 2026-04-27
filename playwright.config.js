import { defineConfig } from '@playwright/test';

// Two Playwright projects, each with its own webServer:
//
//   frontend — playground UI against a static file server on :3210,
//              API surface mocked in-browser via page.route(). Covers
//              the frontend module graph but exercises zero server code.
//
//   e2e      — playground UI against the real server/server.js on :3220
//              with an in-process MQTT broker (aedes) and an in-memory
//              Postgres (pg-mem). Real HTTP + MQTT + DB round-trips.
//
// CI runs both projects. Locally: `npm run test:frontend` or
// `npm run test:e2e` to target one; `npx playwright test` for both.

export default defineConfig({
  testIgnore: ['**/take-screenshots*', '**/screenshots.spec*', '**/take-commissioning*'],
  timeout: 15000,
  retries: 0,
  fullyParallel: true,
  // CI runs unit tests in a separate job, so Playwright gets the full
  // 4-vCPU runner. Tests are largely I/O-bound (selectors, fetches),
  // so 6 workers improves wall-time even though we only have 4 cores.
  workers: process.env.CI ? 6 : 4,
  // CI: dot reporter (one char per test) + github (annotations on failure)
  // keeps logs scannable. Local: list reporter shows full test names live.
  reporter: process.env.CI ? [['dot'], ['github']] : 'list',
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'frontend',
      testDir: './tests/frontend',
      use: {
        browserName: 'chromium',
        baseURL: 'http://localhost:3210',
      },
    },
    {
      name: 'e2e',
      testDir: './tests/e2e',
      testIgnore: ['**/_setup/**'],
      use: {
        browserName: 'chromium',
        baseURL: 'http://localhost:3220',
      },
    },
  ],
  webServer: [
    {
      command: 'cp system.yaml playground/ && mkdir -p playground/shelly && cp shelly/control-logic.js playground/shelly/ && npx serve -l 3210 --no-clipboard',
      port: 3210,
      reuseExistingServer: true,
      timeout: 10000,
    },
    {
      command: 'node tests/e2e/_setup/start.cjs',
      port: 3220,
      reuseExistingServer: true,
      timeout: 20000,
    },
  ],
});
