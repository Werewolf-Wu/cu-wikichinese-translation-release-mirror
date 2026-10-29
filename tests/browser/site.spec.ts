import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const fixtureURL = 'http://127.0.0.1:4322/fixture-site/';

for (const width of [320, 390, 768, 1440]) {
  test(`layout remains readable without horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page.locator('[data-latest-releases] > [data-release-card]')).toHaveCount(5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.locator('[data-release-search]')).toBeVisible();
    await expect(page.locator('[data-contributors] > li')).toHaveCount(40);
    await expect(page.locator('[data-team-roles] > div')).toHaveCount(12);
    expect(errors).toEqual([]);
    if (width === 390 || width === 1440) {
      await mkdir('.cache/screenshots', { recursive: true });
      await page.screenshot({ path: `.cache/screenshots/${width === 390 ? 'mobile' : 'desktop'}.png`, fullPage: false });
    }
  });
}

test('search reaches historical notes and clear restores history state', async ({ page }) => {
  await page.goto('/');
  const history = page.locator('[data-release-history]');
  await history.locator(':scope > summary').click();
  const input = page.locator('[data-release-query]');
  await input.fill('迷你桶');
  await expect(page.locator('[data-release-results]')).toBeVisible();
  expect(await page.locator('[data-search-card]:visible').count()).toBeGreaterThan(0);
  await input.fill('no-such-version-987');
  await expect(page.locator('[data-release-no-results]')).toBeVisible();
  await page.locator('[data-release-clear]').click();
  await expect(page.locator('[data-release-groups]')).toBeVisible();
  await expect(history).toHaveAttribute('open', '');
  await expect(input).toBeFocused();
  await input.fill('Ｖ１．８．３');
  await expect(page.locator('[data-search-card]:visible')).toHaveCount(1);
});

test('download preserves the upstream filename and exact verified bytes', async ({ page }) => {
  await page.goto('/');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-hero-download]').click();
  const download = await downloadPromise;
  const catalog = JSON.parse(await readFile('data/releases.json', 'utf8'));
  const asset = catalog.releases.find((release: { tag: string; source: string }) => release.tag === 'v1.8.3' && release.source === 'upstream').assets[0];
  expect(download.suggestedFilename()).toBe(asset.name);
  expect(await download.failure()).toBeNull();
  const file = await download.path();
  expect(createHash('sha256').update(await readFile(file!)).digest('hex')).toBe(asset.sha256);
});

test('without JavaScript every version remains downloadable through native details', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4321/');
  await expect(page.locator('[data-release-search]')).toBeHidden();
  await page.locator('[data-release-history] > summary').click();
  const catalog = JSON.parse(await readFile('data/releases.json', 'utf8'));
  await expect(page.locator('[data-release-groups] [data-download-asset]:visible')).toHaveCount(catalog.releases.length);
  await context.close();
});

test('large archive and broad search remain bounded; repository base paths work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(fixtureURL);
  const history = page.locator('[data-release-history]');
  await history.locator(':scope > summary').click();
  const list = page.locator('[data-release-history-list]');
  expect(await list.locator(':scope > article').count()).toBeGreaterThan(10);
  const dimensions = await list.evaluate((element) => ({ height: element.clientHeight, scroll: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
  expect(dimensions.overflow).toBe('auto');
  expect(dimensions.scroll).toBeGreaterThan(dimensions.height);
  expect(dimensions.height).toBeLessThanOrEqual(680);
  await page.locator('[data-release-query]').fill('v');
  await expect(page.locator('[data-release-results-list]')).toHaveClass(/scroll-list/);
  const image = page.locator('link[rel="icon"]');
  const iconHref = await image.getAttribute('href');
  expect(iconHref).toMatch(/^\/fixture-site\//);
  expect((await page.request.get(new URL(iconHref!, fixtureURL).href)).status()).toBe(200);
  const href = await page.locator('[data-hero-download]').getAttribute('href');
  expect(href).toMatch(/^\/fixture-site\/downloads\//);
  expect((await page.request.get(new URL(href!, fixtureURL).href)).status()).toBe(200);
  expect(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();
});

test('text spacing overrides preserve content and document width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('[data-hero-download]')).toBeVisible();
});
