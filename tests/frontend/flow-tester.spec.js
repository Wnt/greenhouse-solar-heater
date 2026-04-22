import { test, expect } from './fixtures.js';

// flow-tester.html is a standalone visual-verification page — not
// linked from the SPA nav — that renders one schematic per operating
// mode so pipe highlights and flow directions can be eyeballed
// side-by-side. The spec is deliberately thin: load the page, confirm
// all five mode cards mount and the schematic renders inside each,
// catch any console errors. Production logic lives in schematic.js /
// schematic-topology.js, both already covered by the Components view
// specs — this spec's job is to make sure the tester page itself
// doesn't silently break when those APIs drift.
test.describe('flow-tester page', () => {
  const EXPECTED_MODES = ['idle', 'solar_charging', 'greenhouse_heating', 'active_drain', 'emergency_heating'];

  test('renders one mode card per operating mode with a schematic inside', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/playground/flow-tester.html');

    // Each mode renders into a <section class="mode-card" data-mode="…">.
    // init() iterates sequentially so cards appear one by one; wait
    // for the last expected mode to settle.
    for (const mode of EXPECTED_MODES) {
      await expect(page.locator(`section.mode-card[data-mode="${mode}"]`)).toBeVisible();
    }

    // Each card must have a schematic-host containing an SVG — if
    // buildSchematic rejected, the spec's catch branch replaces the
    // host contents with an error string and no SVG is mounted.
    // init() renders modes sequentially, so poll until every card has
    // its SVG rather than asserting once and racing the last mount.
    await expect.poll(
      () => page.locator('section.mode-card .schematic-host svg').count(),
      { timeout: 10_000 },
    ).toBe(EXPECTED_MODES.length);

    // openValvesSummary renders one span per valve id plus a pump
    // span; emergency_heating adds a space-heater span. Sanity-check
    // that the summary row for solar_charging highlights VI-btm and
    // VO-coll as open (and pump on), confirming the preset reached
    // the DOM.
    const solarCard = page.locator('section.mode-card[data-mode="solar_charging"]');
    await expect(solarCard.locator('.valve-summary span.open', { hasText: 'vi_btm' })).toBeVisible();
    await expect(solarCard.locator('.valve-summary span.open', { hasText: 'vo_coll' })).toBeVisible();
    await expect(solarCard.locator('.valve-summary span.open', { hasText: 'pump ON' })).toBeVisible();

    // idle should list "all closed" — exercises the zero-open branch
    // in openValvesSummary.
    const idleCard = page.locator('section.mode-card[data-mode="idle"]');
    await expect(idleCard.locator('.valve-summary span', { hasText: 'all closed' })).toBeVisible();

    // emergency_heating adds the space-heater span — exercises the
    // `if (mode.space_heater)` branch.
    const emergencyCard = page.locator('section.mode-card[data-mode="emergency_heating"]');
    await expect(emergencyCard.locator('.valve-summary span.open', { hasText: 'space heater ON' })).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
