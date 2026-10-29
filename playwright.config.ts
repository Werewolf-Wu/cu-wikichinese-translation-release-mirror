import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4321',
    headless: true,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
      args: ['--no-sandbox'],
    },
    screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'npm run preview -- --port 4321', url: 'http://127.0.0.1:4321', reuseExistingServer: !process.env.CI },
    {
      command: 'node scripts/astro.mjs preview --root .cache/browser-fixture --port 4322',
      url: 'http://127.0.0.1:4322/fixture-site/',
      reuseExistingServer: !process.env.CI,
      env: { BASE_PATH: '/fixture-site', SITE_URL: 'https://example.invalid' },
    },
  ],
});
