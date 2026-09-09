// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// BASE_URL lets the SAME suite run against:
//   - production            (default, https://accelqsdr.online)
//   - a Netlify deploy preview (CI sets this to the preview URL)
//   - a local dev server     (set BASE_URL=http://localhost:xxxx yourself)
const BASE_URL = process.env.BASE_URL || 'https://accelqsdr.online';

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
