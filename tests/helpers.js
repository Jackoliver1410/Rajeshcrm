// Shared helpers for the accelqsdr.online (SDR Outreach) test suite.
//
// Credentials come ONLY from environment variables -- never hardcode a
// real login here. Tests that need to be logged in call requireCredentials()
// first and skip themselves (rather than fail) when no credentials are
// configured, so the smoke suite still runs cleanly in a fork/PR that
// doesn't have repo secrets.

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

// Writes (creating/editing leads, contacts, accounts, etc.) are OFF by
// default everywhere, including in CI, because Netlify deploy previews
// commonly point at the same backend/database as production unless you've
// specifically set up an isolated per-preview database. Flip this on only
// once you've confirmed BASE_URL points somewhere safe to write to.
const WRITES_ALLOWED = process.env.RUN_WRITE_TESTS === 'true';

// Every record a write-test creates is tagged with this prefix so it's
// trivially identifiable and safe to bulk-delete afterwards.
const TEST_TAG_PREFIX = 'E2E_TEST_';

function requireCredentials(test) {
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    test.skip(true, 'TEST_EMAIL / TEST_PASSWORD not set -- skipping authenticated test. See README-testing.md.');
  }
}

function requireWritesAllowed(test) {
  if (!WRITES_ALLOWED) {
    test.skip(true, 'RUN_WRITE_TESTS is not "true" -- skipping a test that creates/modifies data. See README-testing.md.');
  }
}

/** Logs in via the real UI form (exercises the actual login flow, not just an API call). */
async function login(page, email = TEST_EMAIL, password = TEST_PASSWORD) {
  await page.goto('/');
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  // Dashboard is the first authenticated view; its heading appearing is
  // our signal that #api/login succeeded and app-shell has taken over.
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 15_000 });
}

function newTestTag(label) {
  return `${TEST_TAG_PREFIX}${label}_${Date.now()}`;
}

module.exports = {
  TEST_EMAIL,
  TEST_PASSWORD,
  WRITES_ALLOWED,
  TEST_TAG_PREFIX,
  requireCredentials,
  requireWritesAllowed,
  login,
  newTestTag,
};
