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
  // 4 workers matches the GitHub-hosted runner's vCPU count. Tried 6
  // and saw no wall-time improvement (the 4 cores are already
  // saturated) but did pick up init-race flakes in specs without
  // explicit __initComplete gates — keep it at 4.
  workers: 4,
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
