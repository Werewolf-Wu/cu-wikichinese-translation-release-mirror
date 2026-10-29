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
  const notes = page.locator('[data-latest-releases] [data-release-tag="v1.8.2"] [data-release-notes]');
  await notes.locator('summary').click();
  await expect(notes.locator('h5').first()).toHaveText("What's Changed");
  await expect(notes.getByRole('link', { name: 'PR #1', exact: true }).first()).toBeVisible();
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

test('formatted release notes stay readable on mobile and keep original destinations', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  const notes = page.locator('[data-latest-releases] [data-release-tag="v1.8.2"] [data-release-notes]');
  await notes.locator('summary').click();
  await expect(notes.locator('h5').first()).toHaveText("What's Changed");
  await expect(notes.locator('.release-markdown > ul').first().locator(':scope > li')).toHaveCount(9);
  const pr = notes.getByRole('link', { name: 'PR #1', exact: true }).first();
  await expect(pr).toHaveAttribute('href', 'https://github.com/dodo23333/cu-chinese-wiki-translations/pull/1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('[data-release-query]').fill('pauseQuote');
  const result = page.locator('[data-search-card]:visible [data-release-notes]').first();
  await result.locator('summary').click();
  await expect(result.locator('.release-markdown > ul').first()).toBeVisible();
});

test('pointer focus stays quiet while keyboard focus and reduced-motion toggles remain usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const notes = page.locator('[data-latest-releases] [data-release-notes]').first();
  const summary = notes.locator('summary');
  await summary.click();
  await expect(summary).toHaveCSS('outline-style', 'none');
  await expect(page.locator('[data-hero-download]')).toHaveCSS('-webkit-tap-highlight-color', 'rgba(0, 0, 0, 0)');
  await page.keyboard.press('Tab');
  const link = page.locator(':focus');
  await expect(link).toHaveCSS('outline-style', 'solid');
  await expect(link).toHaveCSS('outline-color', 'rgb(242, 212, 119)');
  await page.keyboard.press('Shift+Tab');
  await expect(summary).toBeFocused();
  await expect(summary).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('Enter');
  await expect(notes).not.toHaveAttribute('open');
  await page.keyboard.press('Space');
  await expect(notes).toHaveAttribute('open');
  expect(await notes.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
});

test('native details animate opening and closing and tolerate rapid reversal', async ({ page }) => {
  await page.goto('/');
  const notes = page.locator('[data-latest-releases] [data-release-tag="v1.8.2"] [data-release-notes]');
  await notes.scrollIntoViewIfNeeded();
  const results = await notes.evaluate(async (element) => {
    const summary = element.querySelector('summary')!;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const height = () => element.getBoundingClientRect().height;
    // ::details-content lives in the browser's details shadow tree; sample layout
    // instead of relying on getAnimations() exposing its pseudo-element transitions.
    const sample = async () => {
      const heights: number[] = [];
      const start = performance.now();
      do { await frame(); heights.push(height()); } while (performance.now() - start < 300);
      return { heights, end: height() };
    };
    const closed = height();
    summary.click();
    const opening = await sample();
    summary.click();
    const closing = await sample();
    summary.click(); await frame(); summary.click(); await frame(); summary.click();
    const final = await sample();
    return { closed, opening, closing, final: final.end, open: element.hasAttribute('open') };
  });
  expect(results.opening.heights.some((height) => height > results.closed && height < results.opening.end)).toBe(true);
  expect(results.closing.heights.some((height) => height > results.closing.end && height < results.opening.end)).toBe(true);
  expect(results.closing.end).toBeCloseTo(results.closed, 0);
  expect(results.open).toBe(true);
  expect(results.final).toBeCloseTo(results.opening.end, 0);
});

test('text spacing overrides preserve content and document width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  await page.addStyleTag({ content: '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('[data-hero-download]')).toBeVisible();
});
