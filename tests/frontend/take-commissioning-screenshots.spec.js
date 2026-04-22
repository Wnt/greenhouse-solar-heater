/**
 * Playwright script to generate commissioning guide screenshots.
 * Captures specific simulation states that match what an operator sees
 * during staged hardware commissioning.
 *
 * Usage: npx playwright test --config=playwright.commissioning.config.js
 */
import { test, expect } from './fixtures.js';
import path from 'path';

const screenshotDir = path.join('design', 'docs', 'commissioning-screenshots');
const DESKTOP = { width: 1280, height: 720 };

function shot(name) {
  return { path: path.join(screenshotDir, name + '.png'), fullPage: false };
}

async function setSlider(page, id, value) {
  await page.evaluate(([sliderId, val]) => {
    const track = document.getElementById(sliderId);
    if (track && track._sliderUpdate) track._sliderUpdate(val);
  }, [id, value]);
}

// Legacy names that were merged into other views. Screenshots still use the
// old names so the doc filenames stay stable.
const HASH_ALIASES = { schematic: 'components', sensors: 'device' };

/** Navigate via hash to avoid sidebar/bottom-nav visibility issues */
async function navTo(page, viewName) {
  const resolved = HASH_ALIASES[viewName] || viewName;
  await page.evaluate((v) => {
    window.location.hash = v;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, resolved);
  await page.waitForTimeout(300);
  await expect(page.locator('#view-' + resolved)).toBeVisible();
}

async function waitForFonts(page) {
  await page.waitForFunction(() => document.fonts.ready.then(() => true), { timeout: 15000 });
  await page.waitForTimeout(500);
}

test.describe('Commissioning Guide Screenshots', () => {
  test.setTimeout(120000);

  test('capture commissioning scenarios', async ({ page }) => {
    // Force simulation mode (?mode=sim) to get FAB play/pause button
    await page.goto('/playground/?mode=sim');
    await expect(page.locator('#view-status')).toBeVisible();
    await waitForFonts(page);
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(300);

    // ── Screenshot 1: Status view — initial state (idle, all sensors reading) ──
    await navTo(page, 'controls');
    await page.waitForTimeout(300);
    await setSlider(page, 'irradiance', 0);
    await setSlider(page, 'tank-top', 20);
    await setSlider(page, 'tank-bot', 18);
    await setSlider(page, 'greenhouse', 12);
    await setSlider(page, 'outdoor', 8);
    await setSlider(page, 'speed', 1);

    await page.locator('#fab-play').click();
    await page.waitForTimeout(2000);
    await page.locator('#fab-play').click(); // pause

    await navTo(page, 'status');
    await page.waitForTimeout(300);
    await page.screenshot(shot('01-status-idle-sensors-reading'));

    // ── Screenshot 2: Components view — all sensors, valves closed ──
    await navTo(page, 'components');
    await page.waitForTimeout(300);
    await page.screenshot(shot('02-components-idle-all-closed'));

    // ── Screenshot 3: Schematic view — idle state ──
    await navTo(page, 'schematic');
    await page.waitForTimeout(300);
    await page.screenshot(shot('03-schematic-idle'));

    // ── Screenshot 4: Controls view — sliders ──
    await navTo(page, 'controls');
    await page.waitForTimeout(300);
    await page.screenshot(shot('04-controls-initial'));

    // ── Screenshot 5: Solar charging active ──
    await setSlider(page, 'irradiance', 800);
    await setSlider(page, 'tank-top', 30);
    await setSlider(page, 'tank-bot', 25);
    await setSlider(page, 'outdoor', 10);
    await setSlider(page, 'speed', 10000);

    await page.locator('#fab-play').click();
    await page.waitForTimeout(3000);
    await page.locator('#fab-play').click(); // pause

    await navTo(page, 'status');
    await page.waitForTimeout(300);
    await page.screenshot(shot('05-status-solar-charging'));

    // ── Screenshot 6: Schematic during solar charging ──
    await navTo(page, 'schematic');
    await page.waitForTimeout(300);
    await page.screenshot(shot('06-schematic-solar-charging'));

    // ── Screenshot 7: Components during solar charging ──
    await navTo(page, 'components');
    await page.waitForTimeout(300);
    await page.screenshot(shot('07-components-solar-charging'));

    // ── Screenshot 8: Freeze drain triggered ──
    await navTo(page, 'controls');
    await setSlider(page, 'outdoor', 1);
    await setSlider(page, 'speed', 10000);

    await page.locator('#fab-play').click();
    await page.waitForTimeout(3000);
    await page.locator('#fab-play').click(); // pause

    await navTo(page, 'status');
    await page.waitForTimeout(300);
    await page.screenshot(shot('08-status-freeze-drain'));

    // ── Screenshot 9: Schematic during active drain ──
    await navTo(page, 'schematic');
    await page.waitForTimeout(300);
    await page.screenshot(shot('09-schematic-active-drain'));

    // ── Screenshot 10: Components during drain ──
    await navTo(page, 'components');
    await page.waitForTimeout(300);
    await page.screenshot(shot('10-components-active-drain'));
  });
});
