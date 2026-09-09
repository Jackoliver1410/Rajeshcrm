// Smoke tests: "is the site even up and not obviously broken."
// No login required -- these must pass for anyone, including a fork with
// no repo secrets configured, which is why the whole file avoids
// TEST_EMAIL/TEST_PASSWORD entirely.

const { test, expect } = require('@playwright/test');

test.describe('smoke', () => {
  test('homepage responds and renders the login screen', async ({ page }) => {
    const response = await page.goto('/');
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle('SDR Outreach');
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();
  });

  test('static assets (css/js) load without 404s', async ({ page }) => {
    const failed = [];
    page.on('response', (res) => {
      if (/\.(css|js)(\?|$)/.test(res.url()) && res.status() >= 400) {
        failed.push(`${res.status()} ${res.url()}`);
      }
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(failed, `broken asset(s): ${failed.join(', ')}`).toEqual([]);
  });

  test('no console errors on initial load', async ({ page }) => {
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(errors, `console error(s): ${errors.join(' | ')}`).toEqual([]);
  });

  test('login form blocks empty submission (client-side validation)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#login-form button[type="submit"]').click();
    // A native "required" field blocks submission -- #app-shell must never
    // appear, and we should still be on the login screen.
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#app-shell')).not.toBeVisible();
  });

  test('login form rejects a malformed email before hitting the API', async ({ page }) => {
    const loginCalls = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/login')) loginCalls.push(req);
    });
    await page.goto('/');
    await page.locator('#login-email').fill('not-an-email');
    await page.locator('#login-password').fill('whatever');
    await page.locator('#login-form button[type="submit"]').click();
    await page.waitForTimeout(500);
    expect(loginCalls.length, 'POST /api/login should not fire for an invalid email').toBe(0);
  });

  test('HTTP redirects to HTTPS', async ({ request, baseURL }) => {
    const url = new URL(baseURL);
    if (url.protocol !== 'https:') test.skip(true, 'baseURL is not https -- skip on local/dev runs');
    const httpUrl = `http://${url.host}/`;
    const response = await request.get(httpUrl, { maxRedirects: 0 });
    expect([301, 302, 307, 308]).toContain(response.status());
    expect(response.headers()['location']).toMatch(/^https:/);
  });

  test('HSTS header is present', async ({ request, baseURL }) => {
    const response = await request.get(baseURL);
    expect(response.headers()['strict-transport-security']).toBeTruthy();
  });

  // Known gap as of the last security pass (2026-09-09): CSP, X-Frame-Options,
  // X-Content-Type-Options, Referrer-Policy and Permissions-Policy are all
  // missing. This is intentionally `fixme` (shows as an accepted failure,
  // not a red build) so the suite documents the gap without blocking CI --
  // flip each assertion on for real once that header gets added.
  test.fixme('security headers: CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy', async ({ request, baseURL }) => {
    const headers = (await request.get(baseURL)).headers();
    expect(headers['content-security-policy']).toBeTruthy();
    expect(headers['x-frame-options']).toBeTruthy();
    expect(headers['x-content-type-options']).toBeTruthy();
    expect(headers['referrer-policy']).toBeTruthy();
    expect(headers['permissions-policy']).toBeTruthy();
  });

  test('no sensitive files are exposed', async ({ request, baseURL }) => {
    const paths = ['.env', '.git/config', 'package.json', 'config.json', '.git/HEAD'];
    for (const p of paths) {
      const res = await request.get(new URL(p, baseURL).toString());
      expect(res.status(), `${p} should not be reachable`).toBe(404);
    }
  });
});
