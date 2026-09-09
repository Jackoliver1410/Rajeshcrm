// Regression tests: each one pins down a specific bug that was found and
// fixed, so it can't silently come back. Add a new test here every time a
// real bug gets fixed on this app -- that's the whole point of this file.

const { test, expect } = require('@playwright/test');
const { login, requireCredentials, requireWritesAllowed, newTestTag } = require('./helpers');

test.describe('regression', () => {
  test.beforeEach(({}, testInfo) => {
    requireCredentials(test);
  });

  // --- Fixed 2026-09-09: table columns were freezing at ~20-30px -----------
  // Root cause: every <td> has overflow-wrap:anywhere/word-break:break-word
  // (so a long email/URL can't overflow its column), but that also let the
  // browser's automatic table layout treat all text as breakable at any
  // character -- so makeTableResizable() could measure and then permanently
  // freeze a free-text column (e.g. Contacts' "Title") at a near-zero width,
  // producing a wall of two-letter lines. Fix: measure with white-space:nowrap
  // forced on, so the frozen width reflects the column's longest whole word
  // instead of a single character. See table-column-fix-*.patch.
  test('data table columns keep a readable minimum width (not frozen unreadably narrow)', async ({ page }) => {
    await login(page);
    await page.locator('.nav-item', { hasText: 'Contacts' }).click();
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();

    const table = page.locator('table.resizable-table').first();
    await expect(table).toBeVisible({ timeout: 10_000 });

    const widths = await table.locator('colgroup col').evaluateAll((cols) =>
      cols.map((c) => parseFloat(c.style.width) || 0)
    );
    expect(widths.length, 'expected a <colgroup> once makeTableResizable() has run').toBeGreaterThan(1);

    // Column 0 is the row-select checkbox and is legitimately narrow --
    // every other column holds real data and should stay above a readable
    // floor. 70px is comfortably below any intentionally-resized column but
    // well above the ~20-30px the original bug produced.
    const MIN_READABLE_PX = 70;
    const dataColumnWidths = widths.slice(1);
    for (const [i, w] of dataColumnWidths.entries()) {
      expect(w, `data column #${i + 1} frozen at ${w}px`).toBeGreaterThanOrEqual(MIN_READABLE_PX);
    }
  });

  test('a long free-text cell (Title) wraps to a few lines, not a dozen', async ({ page }) => {
    await login(page);
    await page.locator('.nav-item', { hasText: 'Contacts' }).click();
    const table = page.locator('table.resizable-table').first();
    await expect(table).toBeVisible({ timeout: 10_000 });

    const headers = await table.locator('thead th').allTextContents();
    const titleIdx = headers.findIndex((h) => h.trim().toUpperCase() === 'TITLE');
    test.skip(titleIdx === -1, 'no TITLE column in this render -- nothing to check');

    const firstRow = table.locator('tbody tr').first();
    const cell = firstRow.locator('td').nth(titleIdx);
    const { height, lineHeight } = await cell.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, lineHeight: parseFloat(cs.lineHeight) || 16 };
    });
    const approxLines = Math.round(height / lineHeight);
    expect(approxLines, `Title cell rendered ${approxLines} lines tall`).toBeLessThanOrEqual(5);
  });

  // --- Write-path regression template (gated) -------------------------------
  // Demonstrates the safe pattern for a regression test that needs to create
  // data: tag everything, skip unless RUN_WRITE_TESTS=true, never touch a
  // record you didn't just create. Extend this file with real write-path
  // regressions the same way once you have one to pin down.
  test('creating a lead via the API succeeds and appears in the Leads list', async ({ page }) => {
    requireWritesAllowed(test);
    await login(page);

    const tag = newTestTag('lead');
    const created = await page.evaluate(async (company) => {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bdm_assigned_id: 1, contact_person: company, company, remarks: 'Created by CI regression test.' }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, tag);
    expect(created.status).toBe(201);

    await page.locator('.nav-item', { hasText: 'Leads' }).click();
    await page.getByPlaceholder('Search contact, company…').fill(tag);
    await expect(page.getByText(tag)).toBeVisible({ timeout: 10_000 });
  });
});
