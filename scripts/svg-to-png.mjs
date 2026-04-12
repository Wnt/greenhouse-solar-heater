import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

const assetDir = path.resolve('playground/assets');

const jobs = [
  { src: 'icon-192.svg', out: 'icon-192.png', w: 192, h: 192 },
  { src: 'icon-512.svg', out: 'icon-512.png', w: 512, h: 512 },
  { src: 'icon-512-maskable.svg', out: 'icon-512-maskable.png', w: 512, h: 512 },
];

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });

for (const job of jobs) {
  const page = await context.newPage();
  const svg = readFileSync(path.join(assetDir, job.src), 'utf8');
  // Embed SVG on a transparent page; set exact viewport so screenshot is 1:1
  await page.setViewportSize({ width: job.w, height: job.h });
  const html = `<!DOCTYPE html><html><head><style>
    html, body { margin: 0; padding: 0; background: transparent; }
    svg { display: block; width: ${job.w}px; height: ${job.h}px; }
  </style></head><body>${svg}</body></html>`;
  await page.setContent(html);
  const el = await page.$('svg');
  const buf = await el.screenshot({ omitBackground: false });
  writeFileSync(path.join(assetDir, job.out), buf);
  console.log(`wrote ${job.out} (${buf.length} bytes)`);
  await page.close();
}

await browser.close();
