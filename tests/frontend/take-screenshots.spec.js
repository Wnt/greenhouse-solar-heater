/**
 * Standalone Playwright script to generate screenshots of the playground.
 * Runs a 24h+ simulation at max speed to capture a rich chart, then takes
 * screenshots of all views in both desktop and mobile viewports.
 *
 * Usage: npm run screenshots
 */
import { test, expect } from './fixtures.js';
import path from 'path';

const screenshotDir = path.join('tests', 'e2e', 'screenshots');

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 720 };

function shot(name) {
  return { path: path.join(screenshotDir, name + '.png'), fullPage: true };
}

async function setSlider(page, id, value) {
  await page.evaluate(([sliderId, val]) => {
    const track = document.getElementById(sliderId);
    if (track && track._sliderUpdate) track._sliderUpdate(val);
  }, [id, value]);
}

/** Navigate to a view using whichever nav is visible at current viewport size */
async function goToView(page, viewName) {
  const sidebar = page.locator(`.sidebar-nav [data-view="${viewName}"]`);
  const bottomNav = page.locator(`.bottom-nav [data-view="${viewName}"]`);
  if (await sidebar.isVisible()) {
    await sidebar.click();
  } else {
    await bottomNav.click();
  }
  await expect(page.locator(`#view-${viewName}`)).toBeVisible();
}

/**
 * Run simulation at max speed until 24h+ of sim time has elapsed.
 * Starts at 08:00, waits until it wraps past midnight and reaches 09:00+.
 */
async function runSimulation24h(page) {
  // Enable day/night cycle for realistic data
  const toggle = page.locator('#day-night-toggle');
  if (await toggle.isVisible()) {
    await toggle.check();
  }

  // Set interesting initial conditions
  await setSlider(page, 'irradiance', 700);
  await setSlider(page, 'tank-top', 30);
  await setSlider(page, 'tank-bot', 25);
  await setSlider(page, 'greenhouse', 12);
  await setSlider(page, 'outdoor', 5);
  await setSlider(page, 'speed', 10000);

  // Start simulation
  await page.locator('#fab-play').click();

  // Wait until 25h+ of sim time passes (past midnight, back to 09:00)
  await page.waitForFunction(() => {
    const el = document.getElementById('sim-time-of-day');
    if (!el) return false;
    const text = el.textContent;
    const [h] = text.split(':').map(Number);
    if (!window._screenshotTracker) {
      window._screenshotTracker = { seenMidnight: false, prevHour: h };
      return false;
    }
    const tracker = window._screenshotTracker;
    if (h < tracker.prevHour && tracker.prevHour >= 20) {
      tracker.seenMidnight = true;
    }
    tracker.prevHour = h;
    return tracker.seenMidnight && h >= 9;
  }, { timeout: 120000, polling: 500 });

  // Don't pause here — caller pauses after switching to desired view
}

test.describe('Generate Screenshots (24h simulation)', () => {
  test.setTimeout(180000);

  test('capture all screenshots', async ({ page }) => {
    await page.goto('/playground/');
    await expect(page.locator('#view-status')).toBeVisible();

    // Wait for fonts (especially Material Symbols icons) to load
    await page.waitForFunction(() => document.fonts.ready.then(() => true), { timeout: 15000 });
    await page.waitForTimeout(500);

    // Switch to simulation mode (localhost starts in live mode where Controls view is unavailable)
    await page.locator('#mode-toggle-switch').click();
    await page.waitForTimeout(200);

    // ── Run 24h simulation at desktop size ──
    await page.setViewportSize(DESKTOP);
    await goToView(page, 'controls');
    await runSimulation24h(page);

    // ── Status view — desktop ──
    // Switch to status while sim is still running so chart renders
    await goToView(page, 'status');
    await page.locator('#time-range-slider .time-range-slider-step[data-range="86400"]').click();
    // Let the chart render a few frames with 24h data visible
    await page.waitForTimeout(1000);
    // Now pause
    await page.locator('#fab-play').click();
    await page.waitForTimeout(300);
    await page.screenshot(shot('status-initial-desktop'));
    await page.screenshot(shot('status-solar-charging-desktop'));
    await page.screenshot(shot('status-greenhouse-heating-desktop'));

    // ── Status view — mobile ──
    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(300);
    await page.screenshot(shot('status-initial-mobile'));
    await page.screenshot(shot('status-running-mobile'));

    // ── Components view ──
    await page.setViewportSize(DESKTOP);
    await goToView(page, 'components');
    await page.screenshot(shot('components-desktop'));

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(200);
    await page.screenshot(shot('components-mobile'));

    // ── Schematic view ──
    await page.setViewportSize(DESKTOP);
    await goToView(page, 'schematic');
    await page.screenshot(shot('schematic-desktop'));

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(200);
    await page.screenshot(shot('schematic-mobile'));

    // ── Controls view ──
    await page.setViewportSize(DESKTOP);
    await goToView(page, 'controls');
    await page.screenshot(shot('controls-desktop'));
    await page.screenshot(shot('controls-daynight-desktop'));

    // ── README hero screenshot (desktop, status view, 24h chart visible) ──
    await page.setViewportSize({ width: 1280, height: 1100 });
    await goToView(page, 'status');
    await page.locator('#time-range-slider .time-range-slider-step[data-range="86400"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({
      path: path.join(screenshotDir, 'readme-hero.png'),
      fullPage: false,
    });
  });
});
