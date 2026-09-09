// Functional tests: logs in as a real user and walks every tab, checking
// each one actually renders its data and doesn't throw. Requires
// TEST_EMAIL / TEST_PASSWORD (see README-testing.md) -- every test calls
// requireCredentials() first and skips cleanly if they're not set, so this
// file never fails a CI run that simply hasn't configured secrets yet.
//
// Nothing in this file writes data. Anything that *creates* or *edits* a
// record lives in regression.spec.js's write-gated tests instead, behind
// RUN_WRITE_TESTS -- see helpers.js for why.

const { test, expect } = require('@playwright/test');
const { login, requireCredentials } = require('./helpers');

test.describe('functional', () => {
  test.beforeEach(({}, testInfo) => {
    requireCredentials(test);
  });

  test('valid login reaches the dashboard', async ({ page }) => {
    await login(page);
    await expect(page.getByText('Platform Admin').or(page.locator('.sidebar-profile-title'))).toBeVisible();
    await expect(page.locator('#login-screen')).not.toBeVisible();
  });

  test('invalid password is rejected with a visible error, not a silent hang', async ({ page }) => {
    await page.goto('/');
    await page.locator('#login-email').fill(process.env.TEST_EMAIL);
    await page.locator('#login-password').fill('definitely-the-wrong-password-123');
    await page.locator('#login-form button[type="submit"]').click();
    await expect(page.locator('#login-error')).not.toBeEmpty({ timeout: 10_000 });
    await expect(page.locator('#app-shell')).not.toBeVisible();
  });

  // One test per nav tab: click it, confirm the heading shows up, confirm
  // nothing logged a console error or left a permanently-stuck "Loading…"
  // placeholder, confirm every XHR the tab fired came back non-5xx.
  const tabs = [
    { name: 'Dashboard', heading: 'Dashboard' },
    { name: 'Contacts', heading: 'Contacts' },
    { name: 'Accounts', heading: 'Accounts' },
    { name: 'Emailing', heading: 'Emailing' },
    { name: 'Activity Report', heading: 'Activity Report' },
    { name: 'Leads', heading: 'Leads' },
    { name: 'Leaves / WFH', heading: 'Leaves / WFH' },
  ];

  for (const tab of tabs) {
    test(`"${tab.name}" tab loads its data`, async ({ page }) => {
      const consoleErrors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      page.on('pageerror', (err) => consoleErrors.push(String(err)));
      const failedRequests = [];
      page.on('response', (res) => {
        if (res.url().includes('/api/') && res.status() >= 500) {
          failedRequests.push(`${res.status()} ${res.url()}`);
        }
      });

      await login(page);
      await page.getByRole('link', { name: tab.name, exact: true }).or(page.locator('.nav-item', { hasText: tab.name })).first().click();
      await expect(page.getByRole('heading', { name: tab.heading })).toBeVisible();

      // Give in-flight XHRs a moment to settle, then make sure the tab
      // didn't get stuck on its own loading placeholder.
      await page.waitForLoadState('networkidle');
      await expect(page.getByText('Loading…')).not.toBeVisible();

      expect(failedRequests, `5xx from API: ${failedRequests.join(', ')}`).toEqual([]);
      expect(consoleErrors, `console error(s): ${consoleErrors.join(' | ')}`).toEqual([]);
    });
  }

  test('Contacts tab exposes its expected actions', async ({ page }) => {
    await login(page);
    await page.locator('.nav-item', { hasText: 'Contacts' }).click();
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
    for (const label of ['Export CSV', 'Export XLSX', 'New Contact']) {
      await expect(page.getByText(label, { exact: false })).toBeVisible();
    }
  });

  test('sign out returns to the login screen', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('#login-screen')).toBeVisible({ timeout: 10_000 });
  });
});
