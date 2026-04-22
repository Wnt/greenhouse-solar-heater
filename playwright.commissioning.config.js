import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/frontend',
  testMatch: 'take-commissioning-screenshots.spec.js',
  timeout: 120000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3210',
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'cp system.yaml playground/ && mkdir -p playground/shelly && cp shelly/control-logic.js playground/shelly/ && npx serve -l 3210 --no-clipboard',
    port: 3210,
    reuseExistingServer: true,
    timeout: 10000,
  },
});
