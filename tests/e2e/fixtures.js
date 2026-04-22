/**
 * Shared Playwright fixtures for tests/e2e/ — real-server specs.
 *
 * Mirrors tests/frontend/fixtures.js (blocks Google Fonts so page
 * loads don't hang in offline environments), and additionally
 * exposes an `mqtt` helper for connecting to the in-process aedes
 * broker that the e2e harness boots alongside server/server.js.
 */

import { test as base, expect } from '@playwright/test';
import mqtt from 'mqtt';

const MQTT_URL = 'mqtt://127.0.0.1:1883';

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    await use(page);
  },
  mqttClient: async ({}, use) => {
    const client = mqtt.connect(MQTT_URL, { connectTimeout: 2000 });
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    await use(client);
    await new Promise(r => client.end(false, {}, r));
  },
});

export { expect };
