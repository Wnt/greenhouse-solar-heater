/**
 * Icon generator for Helios Canopy PWA + push notifications.
 *
 * Renders every icon (app icons, Android status-bar badge, per-category
 * notification icons) from the vendored Material Symbols font via
 * Playwright/Chromium. Single source of truth — run this whenever the
 * brand icon or any notification glyph changes.
 *
 *     node scripts/make-icons.mjs
 *
 * Outputs into playground/assets/:
 *   - icon-192.png            (PWA app icon, rounded square)
 *   - icon-512.png            (PWA app icon, rounded square)
 *   - icon-512-maskable.png   (PWA maskable icon, safe-zone padding)
 *   - badge-72.png            (Android status-bar silhouette)
 *   - notif-evening.png       (evening_report notification icon)
 *   - notif-noon.png          (noon_report)
 *   - notif-overheat.png      (overheat_warning)
 *   - notif-freeze.png        (freeze_warning)
 *   - notif-offline.png       (offline_warning)
 */

import { chromium } from 'playwright';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const assetDir = path.join(repoRoot, 'playground', 'assets');
const fontPath = path.join(repoRoot, 'playground', 'vendor', 'material-symbols-outlined.woff2');

// Stitch theme tokens (kept in sync with playground/css/style.css).
const DARK_BG = '#0c0e12';
const GOLD = '#e9c349';
const CORAL = '#ee7d77';
const TEAL = '#43aea4';
const SKY = '#42a5f5';

// App-icon glyph stays `solar_power` — matches the sidebar brand icon.
const APP_GLYPH = 'solar_power';

// Per-category notification glyphs.
//   evening_report  → wb_sunny    (gold — solar summary)
//   noon_report     → bedtime     (teal — overnight heating summary)
//   overheat_warning→ local_fire_department (coral — tank hot)
//   freeze_warning  → ac_unit     (sky — outdoor cold)
//   offline_warning → cloud_off   (coral — controller unreachable)
const NOTIF_ICONS = [
  { slug: 'evening',  glyph: 'wb_sunny',              color: GOLD  },
  { slug: 'noon',     glyph: 'bedtime',               color: TEAL  },
  { slug: 'overheat', glyph: 'local_fire_department', color: CORAL },
  { slug: 'freeze',   glyph: 'ac_unit',               color: SKY   },
  { slug: 'offline',  glyph: 'cloud_off',             color: CORAL },
];

function renderHtml(config) {
  const { size, glyph, glyphColor, bgColor, bgRadius, glyphScale, transparent } = config;
  const glyphSize = Math.round(size * glyphScale);
  const radiusPx = Math.round(size * bgRadius);
  // The @font-face src is loaded via a same-origin file:// reference —
  // this only works because the HTML is served from a file:// URL (see
  // renderIcon), not about:blank.
  const fontUrl = pathToFileURL(fontPath).href;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @font-face {
      font-family: 'Material Symbols Outlined';
      font-style: normal;
      font-weight: 100 700;
      font-display: block;
      src: url('${fontUrl}') format('woff2');
    }
    html, body { margin: 0; padding: 0; background: ${transparent ? 'transparent' : DARK_BG}; }
    .wrapper {
      width: ${size}px;
      height: ${size}px;
      background: ${bgColor};
      border-radius: ${radiusPx}px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
    }
    .glyph {
      font-family: 'Material Symbols Outlined';
      font-weight: normal;
      font-style: normal;
      font-size: ${glyphSize}px;
      color: ${glyphColor};
      line-height: 1;
      letter-spacing: normal;
      text-transform: none;
      display: inline-block;
      white-space: nowrap;
      word-wrap: normal;
      direction: ltr;
      font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 48;
      font-feature-settings: 'liga';
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
  </style></head><body><div class="wrapper"><span class="glyph">${glyph}</span></div></body></html>`;
}

async function renderIcon(browser, tmpDir, file, config) {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { width: config.size, height: config.size },
  });
  const page = await context.newPage();
  // Write the HTML to a file and navigate via file:// — this is the only
  // reliable way to get Chromium to honor same-origin file:// fetches for
  // the vendored woff2 font. setContent() with an about:blank origin gets
  // "Not allowed to load local resource" errors.
  const htmlPath = path.join(tmpDir, 'icon-' + file.replace(/\W+/g, '_') + '.html');
  writeFileSync(htmlPath, renderHtml(config));
  await page.goto(pathToFileURL(htmlPath).href);
  await page.evaluate(() => document.fonts.ready);
  // Small delay to ensure the glyph is actually painted.
  await new Promise((r) => setTimeout(r, 50));
  const wrapper = await page.locator('.wrapper');
  const buf = await wrapper.screenshot({ omitBackground: config.transparent });
  writeFileSync(path.join(assetDir, file), buf);
  try { unlinkSync(htmlPath); } catch (e) { /* ignore */ }
  console.log(`  ${file}  (${buf.length} bytes)`);
  await context.close();
}

async function main() {
  console.log('Generating icons from Material Symbols font...');
  const browser = await chromium.launch();
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'make-icons-'));
  try {
    // ── App icons (rounded-square dark card with filled gold glyph) ──
    // Matches the sidebar brand icon style — rgba(233,195,73,0.12) gold
    // wash over the dark app background, with the solar_power glyph in
    // primary gold.
    const appCardBg = 'rgba(233, 195, 73, 0.12)';
    for (const size of [192, 512]) {
      await renderIcon(browser, tmpDir, `icon-${size}.png`, {
        size,
        glyph: APP_GLYPH,
        glyphColor: GOLD,
        bgColor: appCardBg,
        bgRadius: 0.2,          // 20% — matches Android adaptive-icon rounding
        glyphScale: 0.58,        // glyph fills ~58% of canvas
        transparent: false,      // dark bg baked in
      });
    }
    // Maskable icon: Android will crop to a circle at ~80% inner safe
    // zone, so shrink the glyph to stay inside.
    await renderIcon(browser, tmpDir, 'icon-512-maskable.png', {
      size: 512,
      glyph: APP_GLYPH,
      glyphColor: GOLD,
      bgColor: appCardBg,
      bgRadius: 0,               // maskable = no rounding, Android applies it
      glyphScale: 0.42,
      transparent: false,
    });

    // ── Android status-bar badge ──
    // The `badge` property on a Notification is masked to white by
    // Android, so only the alpha channel matters. We render the
    // solar_power glyph filled white on a transparent background so
    // Android's white mask lands on a recognisable silhouette instead
    // of a solid rectangle (which is what a fully-opaque icon produces).
    await renderIcon(browser, tmpDir, 'badge-72.png', {
      size: 72,
      glyph: APP_GLYPH,
      glyphColor: '#ffffff',
      bgColor: 'transparent',
      bgRadius: 0,
      glyphScale: 0.78,
      transparent: true,
    });

    // ── Per-category notification icons ──
    // These are the larger icons shown next to the notification title.
    // Rendered on the dark app background so they read well in both
    // system light and dark themes.
    for (const n of NOTIF_ICONS) {
      await renderIcon(browser, tmpDir, `notif-${n.slug}.png`, {
        size: 192,
        glyph: n.glyph,
        glyphColor: n.color,
        bgColor: DARK_BG,
        bgRadius: 0.2,
        glyphScale: 0.58,
        transparent: false,
      });
    }
  } finally {
    await browser.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
