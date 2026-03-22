import { test, expect } from '@playwright/test';

test.describe('PWA Installability', () => {
  test('index.html has manifest link', async ({ page }) => {
    await page.goto('/monitor/index.html');
    const manifest = page.locator('link[rel="manifest"]');
    await expect(manifest).toHaveAttribute('href', '/manifest.json');
  });

  test('index.html has theme-color meta tag', async ({ page }) => {
    await page.goto('/monitor/index.html');
    const themeColor = page.locator('meta[name="theme-color"]');
    await expect(themeColor).toHaveAttribute('content', '#0056b2');
  });

  test('index.html has Apple meta tags', async ({ page }) => {
    await page.goto('/monitor/index.html');
    const capable = page.locator('meta[name="apple-mobile-web-app-capable"]');
    await expect(capable).toHaveAttribute('content', 'yes');

    const statusBar = page.locator('meta[name="apple-mobile-web-app-status-bar-style"]');
    await expect(statusBar).toHaveAttribute('content', 'default');

    const touchIcon = page.locator('link[rel="apple-touch-icon"]');
    await expect(touchIcon).toHaveAttribute('href', '/icons/icon-192.png');
  });

  test('login.html has manifest link and theme-color', async ({ page }) => {
    await page.goto('/monitor/login.html');
    const manifest = page.locator('link[rel="manifest"]');
    await expect(manifest).toHaveAttribute('href', '/manifest.json');

    const themeColor = page.locator('meta[name="theme-color"]');
    await expect(themeColor).toHaveAttribute('content', '#0056b2');
  });

  test('login.html has Apple meta tags', async ({ page }) => {
    await page.goto('/monitor/login.html');
    const capable = page.locator('meta[name="apple-mobile-web-app-capable"]');
    await expect(capable).toHaveAttribute('content', 'yes');

    const statusBar = page.locator('meta[name="apple-mobile-web-app-status-bar-style"]');
    await expect(statusBar).toHaveAttribute('content', 'default');

    const touchIcon = page.locator('link[rel="apple-touch-icon"]');
    await expect(touchIcon).toHaveAttribute('href', '/icons/icon-192.png');
  });

  test('manifest.json is valid and has required fields', async ({ page }) => {
    const response = await page.goto('/monitor/manifest.json');
    const manifest = await response.json();

    expect(manifest.name).toBe('Greenhouse Monitor');
    expect(manifest.short_name).toBe('Monitor');
    expect(manifest.start_url).toBe('/');
    expect(manifest.id).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);

    // Check 512px icon has maskable purpose
    const icon512 = manifest.icons.find(function (i) { return i.sizes === '512x512'; });
    expect(icon512).toBeDefined();
    expect(icon512.purpose).toBe('any maskable');
  });

  test('service worker file is accessible', async ({ page }) => {
    const response = await page.goto('/monitor/sw.js');
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain("addEventListener('fetch'");
  });

  test('offline.html exists and has correct content', async ({ page }) => {
    await page.goto('/monitor/offline.html');
    await expect(page.locator('h1')).toHaveText('Greenhouse Monitor');
    await expect(page.locator('p')).toContainText('offline');
    await expect(page.locator('.retry-btn')).toBeVisible();
  });
});
