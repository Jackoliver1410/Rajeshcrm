# accelqsdr.online — test suite & CI/CD

Playwright suite covering smoke, functional, and regression tests for the
SDR Outreach app, plus GitHub Actions workflows to run it automatically.

## What's here

```
tests/
  helpers.js        shared login helper + safety gates (see below)
  smoke.spec.js      no login required — is the site up, no console errors,
                      basic security headers, no exposed sensitive files
  functional.spec.js  logs in, walks every tab, checks each one renders
                      without errors — READ ONLY, never writes data
  regression.spec.js  pins down specific bugs that were found & fixed, so
                      they can't come back silently
playwright.config.js  BASE_URL-driven config — same suite runs against
                      production, a Netlify deploy preview, or localhost
.github/workflows/
  pr-preview-tests.yml    runs smoke+functional+regression against each
                          PR's Netlify deploy preview (before merge)
  post-merge-tests.yml    simpler alternative: runs after merge to main,
                          against production (use this OR the preview one,
                          or both)
  production-smoke.yml    scheduled smoke test against the live site,
                          independent of any code push
```

## 1. Install and run locally

```bash
npm install
npx playwright install --with-deps chromium
npm run test:smoke          # no credentials needed
```

For the functional/regression suites, set credentials for a real account
first (a dedicated test user is strongly recommended over your own admin
login — ask whoever manages users to create one):

```bash
export TEST_EMAIL="test-user@yourcompany.com"
export TEST_PASSWORD="..."
npm run test:functional
npm run test:regression
```

Point at a different environment with `BASE_URL`:

```bash
BASE_URL=https://deploy-preview-42--your-site.netlify.app npm test
```

## 2. Wire up GitHub Actions

1. Already done in this PR — `.github/workflows/`, `tests/`,
   `playwright.config.js`, and `package.json`'s scripts/devDependencies are
   all in place.
2. In your repo's **Settings → Secrets and variables → Actions**, add:
   - `TEST_EMAIL`, `TEST_PASSWORD` — a real login the tests can use. **Use a
     dedicated test account, not a personal one**, if you can — it'll show
     up in activity reports / audit trails like any other user otherwise.
3. **Choose one (or both) deploy-gating workflows:**
   - `pr-preview-tests.yml` tests each PR's Netlify deploy preview *before*
     merge — the safer, earlier check. It needs Netlify's GitHub
     Deployment notifications enabled (Netlify dashboard → your site →
     **Site configuration → Build & deploy → Deploy notifications** → add a
     "Deploy Preview succeeded" GitHub Deployment notification if one isn't
     already there — Netlify's UI moves this around between versions, so if
     the workflow never triggers, that setting is the first thing to check).
   - `post-merge-tests.yml` is a no-setup-required fallback: it just runs
     after main is pushed and Netlify has had time to deploy. Less ideal
     (catches problems after they're already live) but works with zero
     Netlify-side configuration.
4. `production-smoke.yml` needs no secrets and no setup — it'll start
   running on its schedule as soon as it's in the repo. Adjust the cron if
   every 6 hours is more or less than you want.

## 3. About writing data in tests (read this before setting `RUN_WRITE_TESTS`)

`regression.spec.js` includes one test that creates a real lead via the
API, as a template for future write-path regression tests. It's gated
behind `RUN_WRITE_TESTS=true` and **off everywhere by default**, including
in every workflow above, because:

- Netlify deploy previews commonly share the *same* backend/database as
  production unless you've explicitly set up an isolated one per preview.
  If yours do, flipping this on in `pr-preview-tests.yml` will create real
  records in your real data every time a PR opens.
- Every record any write-test creates is tagged `E2E_TEST_<name>_<timestamp>`
  so it's trivially identifiable, but the app's delete endpoint requires
  your account password in the request body (by design), so tests can't
  clean up after themselves automatically — someone has to delete them via
  the UI afterward.

Only set the `RUN_WRITE_TESTS` repository **variable** (not secret — it's
not sensitive) to `"true"` once you've either provisioned an isolated
database for deploy previews, or you're deliberately OK with test leads
landing in production and are prepared to clean them up.

## 4. Extending the suite

- Found a new bug? Fix it, then add a test for it in `regression.spec.js`
  the same way the column-width one is written: comment explaining the
  root cause, assertion that pins down the specific symptom.
- New tab or major feature? Add it to the `tabs` array in
  `functional.spec.js`.
- The security-header gaps from the last audit (CSP, X-Frame-Options,
  X-Content-Type-Options, Referrer-Policy, Permissions-Policy — all
  missing as of 2026-09-09) have `test.fixme()` placeholders in
  `smoke.spec.js`. Once you add a header, delete its line from the
  `fixme` block and it becomes a real enforced assertion.
