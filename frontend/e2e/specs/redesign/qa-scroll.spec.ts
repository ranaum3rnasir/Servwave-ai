import { test, expect, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient, provisionedAdmin } from '../../helpers/api-client';

/**
 * QA validation — "Add team member…" combobox mouse-wheel scroll fix.
 *
 * Product-owner report, verbatim: the "Add team member…" dropdown in the New Event dialog
 * "is not scrollable using the mouse scroll." The list opened, arrow keys worked, the wheel
 * did nothing.
 *
 * Root cause: Radix's `Popover` portals `PopoverContent` to `document.body`, which places it
 * OUTSIDE the DOM subtree a modal `<Dialog>` registers as its scroll-lock shard. `react-remove-
 * scroll` installs a capture-phase `wheel` listener on `document` and `preventDefault()`s any
 * wheel event not inside the dialog's own content or a registered shard, so the list's native
 * `overflow-y-auto` scroll never runs. Arrow keys still worked because cmdk drives those with
 * `scrollIntoView()`, not a wheel event.
 *
 * Fix under test: `frontend/src/ui-kit/components/form/combobox.tsx`'s `CommandList` grew an
 * `onWheel` handler that drives `scrollTop` directly (`event.currentTarget.scrollTop +=
 * event.deltaY`) and calls `preventDefault()` itself, sidestepping the scroll lock entirely.
 * The fix is scoped to the combobox's own `CommandList` usage — `ui-kit/components/ui/
 * command.tsx` (the shared cmdk primitive) is untouched, so the OTHER consumer of `Command`
 * (`frontend/src/pages/v2/jobs/components/bulkBar.tsx`'s "Assign" popover, which is NOT
 * inside a modal Dialog) must be unaffected.
 *
 * jsdom cannot scroll, so no unit test can prove the wheel actually moves the list — this
 * spec drives GENUINE `page.mouse.wheel()` events over the rendered list and reads `scrollTop`
 * before/after, rather than asserting the handler exists.
 *
 * Run-id trap: no module-scope `Math.random()` for run ids — `runId` is derived lazily inside
 * `beforeAll` from `.auth/e2e-org.json`'s `organizationId` (via `provisionedAdmin()`), which
 * does not exist at module-import time (global-setup runs first).
 *
 * Console-error trap: the pre-existing `POST /api/communication/phone-access` 409 shows as a
 * bare "Failed to load resource: the server responded with a status of 409 (Conflict)" console
 * error with no URL — filtered below by that pattern, same as the sibling qa-*.spec.ts files.
 *
 * Popover-scoping trap: Radix's `PopoverContent` also renders `role="dialog"` and is portalled
 * to `document.body` as a SIBLING of the parent Event `<Dialog>`, not a descendant — scoping
 * a popover locator under the Event dialog's own locator finds nothing (documented in
 * qa-picker.spec.ts). Both popovers here are found from `page`, disambiguated by a search
 * input placeholder only that popover has.
 */

// Wider/taller than Playwright's 1280x720 default. The New Event dialog is vertically
// centered and the "Add team member" popover opens BELOW its trigger, near the bottom of
// the dialog — at the default viewport height the popover's own CommandList (capped to
// max-h-64 = 256px, so it always needs room to render fully once ~6+ options exist) was
// rendered mostly below the visible viewport. `toBeVisible()` doesn't require in-viewport,
// so that assertion still passed, but `page.mouse.wheel()` targets real screen coordinates —
// a wheel dispatched at a point below the actual rendered viewport never reaches the list at
// all, which is what produced the first failed run of this spec (scrollTop stuck at 0).
test.use({ viewport: { width: 1280, height: 1000 } });

let api: ApiClient;
let runId: string;

/** Options needed to overflow the combobox's `max-h-64` (16rem / 256px) CommandList. A fresh
 *  provisioned org has exactly one user (the admin), so this many TECHNICIAN users are seeded
 *  on the throwaway org below, well past what six or seven ~36px rows need to overflow 256px. */
const SEEDED_USER_COUNT = 30;
let seededLabels: string[] = [];

test.beforeAll(async () => {
  api = await new ApiClient().init();
  runId = provisionedAdmin().organizationId.slice(0, 8);

  // Email includes Date.now(), not just runId: a failing test in this file discards the
  // Playwright worker and re-imports the module, which re-runs beforeAll from scratch. A
  // fixed email would 409 as a duplicate on that second beforeAll call.
  const stamp = Date.now();
  const labels: string[] = [];
  for (let i = 0; i < SEEDED_USER_COUNT; i++) {
    const first = `QAScroll${i}`;
    const last = `Tech${runId}`;
    const { res, body } = await api.createUser({
      email: `qa-scroll-${runId}-${stamp}-${i}@e2e-qa.invalid`,
      password: 'Test123!@#',
      first_name: first,
      last_name: last,
      role: 'TECHNICIAN',
    });
    expect(res.ok(), `seed user #${i} failed: ${res.status()} ${JSON.stringify(body)}`).toBeTruthy();
    labels.push(`${first} ${last}`);
  }
  seededLabels = labels;
});

test.afterAll(async () => {
  await api.dispose();
});

/** assertGatesClean, but strips the known-unrelated phone-access 409 (see file doc comment). */
function assertGatesCleanQa(gate: { pageErrors: string[]; bad5xx: string[] }, ctx = '') {
  const pageErrors = gate.pageErrors.filter((e) => !/409 \(Conflict\)/i.test(e));
  expect(pageErrors, `pageerror/console errors ${ctx}`).toEqual([]);
  expect(gate.bad5xx, `unexpected /api 5xx ${ctx}`).toEqual([]);
}

test.describe('QA scroll — "Add team member" combobox mouse-wheel fix', () => {
  test('1+2+3: real wheel events scroll the list (not the page), keyboard/typing/select still work', async ({ gatedPage: page, gate }) => {
    await page.goto('/schedule');
    await expect(page.locator('.schedule-cal')).toBeVisible();

    const newEventBtn = page.getByRole('button', { name: 'New Event' });
    await expect(newEventBtn).toBeVisible({ timeout: 15_000 });
    await newEventBtn.click();

    // Scoped by accessible name — TimeCombobox's own Radix Popover also renders
    // role="dialog" (data-state="closed" once committed), so an unscoped
    // `getByRole('dialog')` is a strict-mode violation the moment a time field is touched.
    const dialog = page.getByRole('dialog', { name: 'New Event' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#event-entry-start-time')).not.toHaveValue('');

    const trigger = dialog.getByRole('combobox', { name: 'Add team member' });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // Found from `page`, not `dialog` — see the popover-scoping trap in the file doc comment.
    const panel = page.locator('[data-slot="popover-content"]').filter({ has: page.getByPlaceholder('Search team…') });
    await expect(panel).toBeVisible();
    const list = panel.locator('[data-slot="command-list"]');
    await expect(list).toBeVisible();

    // `useAssignableUsers` fetches after the popover mounts — the list briefly renders with
    // 0-1 rows (scrollHeight === clientHeight, an 80px sliver) before the 31 seeded+admin
    // users land. Wait for the roster to actually be in the DOM before measuring overflow,
    // or this reads as "does not overflow" purely from a race, not a real defect.
    const allItems = list.locator('[data-slot="command-item"]');
    await expect.poll(() => allItems.count(), { timeout: 10_000 }).toBeGreaterThan(10);

    // ── Overflow precondition — prove the list actually has something to scroll ─────────
    const { scrollHeight, clientHeight } = await list.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(
      scrollHeight,
      `list scrollHeight ${scrollHeight} does not exceed clientHeight ${clientHeight} — ` +
        `${SEEDED_USER_COUNT} seeded users did not overflow max-h-64; scroll cannot be proven`,
    ).toBeGreaterThan(clientHeight);

    // ── Point 1 — genuine wheel event scrolls the list ──────────────────────────────────
    const beforeScrollTop = await list.evaluate((el) => el.scrollTop);
    expect(beforeScrollTop, 'list should start unscrolled').toBe(0);

    const box = await list.boundingBox();
    if (!box) throw new Error('combobox list has no bounding box — not actually rendered');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    // ── Point 2 — record the page's own scroll position before/after, to prove the wheel
    //    event scrolled the LIST, not the document behind the modal ─────────────────────
    const bodyScrollBefore = await page.evaluate(() => document.scrollingElement?.scrollTop ?? window.scrollY);

    await page.mouse.wheel(0, 400);
    await expect.poll(() => list.evaluate((el) => el.scrollTop), {
      message: 'scrollTop did not increase after a downward wheel event — the fix is not working',
    }).toBeGreaterThan(beforeScrollTop);
    const afterDownScrollTop = await list.evaluate((el) => el.scrollTop);

    const bodyScrollAfterDown = await page.evaluate(() => document.scrollingElement?.scrollTop ?? window.scrollY);
    expect(bodyScrollAfterDown, 'the page behind the dialog scrolled instead of the list').toBe(bodyScrollBefore);

    // Wheel back up — proves the handler tracks direction (`+= event.deltaY`), not just a
    // one-shot nudge.
    await page.mouse.wheel(0, -600);
    await expect.poll(() => list.evaluate((el) => el.scrollTop), {
      message: 'scrollTop did not decrease after an upward wheel event',
    }).toBeLessThan(afterDownScrollTop);
    const afterUpScrollTop = await list.evaluate((el) => el.scrollTop);

    // eslint-disable-next-line no-console
    console.log(
      `[qa-scroll] list scrollHeight=${scrollHeight} clientHeight=${clientHeight} | ` +
        `scrollTop before=${beforeScrollTop} afterWheelDown(+400)=${afterDownScrollTop} afterWheelUp(-600)=${afterUpScrollTop} | ` +
        `documentScrollTop before=${bodyScrollBefore} afterWheelDown=${bodyScrollAfterDown}`,
    );

    // ── Point 3a — arrow keys still move the highlighted option (keyboard-only, no typing) ──
    // NOT assumed to start at index 0: cmdk highlights on pointer hover too, and the mouse
    // is still sitting over the list from the wheel test above (it may be hovering a
    // scrolled-into-view row, not the first one). Read whatever IS highlighted right now as
    // the baseline instead, then prove ArrowDown moves it to a different item.
    const search = panel.getByPlaceholder('Search team…');
    await search.click(); // refocus keyboard on the input; does not itself change cmdk's highlight
    const selected = list.locator('[data-slot="command-item"][data-selected="true"]');
    await expect(selected).toHaveCount(1, { timeout: 5_000 });
    const beforeArrowLabel = (await selected.innerText()).trim();
    await page.keyboard.press('ArrowDown');
    await expect(selected).toHaveCount(1, { timeout: 5_000 });
    const afterArrowLabel = (await selected.innerText()).trim();
    expect(afterArrowLabel, 'ArrowDown did not move the cmdk highlight to a different option').not.toBe(beforeArrowLabel);

    // ── Point 3b — Enter selects the arrow-highlighted option and adds its chip ─────────
    await page.keyboard.press('Enter');
    await expect(panel).toBeHidden();
    const chipFromArrow = dialog.getByText(afterArrowLabel, { exact: true });
    await expect(chipFromArrow).toBeVisible({ timeout: 5_000 });

    // ── Point 3c — typing filters the list, and selecting the typed match still works ──
    await trigger.click();
    await expect(panel).toBeVisible();
    const search2 = panel.getByPlaceholder('Search team…');
    // Any seeded label other than the one already added above.
    const typedLabel = seededLabels.find((l) => l !== afterArrowLabel && l !== beforeArrowLabel)!;
    await search2.fill(typedLabel);
    const itemsFiltered = list.locator('[data-slot="command-item"]');
    // cmdk's filter is a FUZZY subsequence scorer, not a substring match — these seeded
    // labels only differ by a number inside an otherwise-shared "QAScroll{n} Tech{runId}"
    // shape, and that number can turn up as a stray subsequence match inside a DIFFERENT
    // label's own runId suffix (all-hex, so full of stray digits). Typing one full label
    // reliably narrows the 31-row list, but not always down to exactly 1 — so this proves
    // "typing filters" via the narrowed count, then targets the exact row with Playwright's
    // own (contiguous, non-fuzzy) text filter rather than assuming cmdk ranked it first —
    // and selects it with a click rather than Enter, since which row Enter would land on is
    // exactly the ambiguity this narrows away. Point 3a/3b above already proves Enter itself
    // selects the arrow-highlighted row.
    await expect.poll(() => itemsFiltered.count(), { timeout: 5_000 }).toBeLessThan(SEEDED_USER_COUNT + 1);
    const targetItem = itemsFiltered.filter({ hasText: typedLabel });
    await expect(targetItem.first()).toBeVisible({ timeout: 5_000 });
    await targetItem.first().click();
    await expect(panel).toBeHidden();
    const chipFromTyping = dialog.getByText(typedLabel, { exact: true });
    await expect(chipFromTyping).toBeVisible({ timeout: 5_000 });

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-scroll-1+2+3');
    await screenshotAndAssert(page, 'qa-scroll-01-add-team-member.png');
  });

  test('4: bulkBar\'s Command list (the other consumer of the shared primitive, not inside a modal) is unaffected', async ({ gatedPage: page, gate }) => {
    // Seed a standalone job (no estimate needed — customer + location is enough) so there is
    // a row to select on /jobs.
    const stamp = Date.now();
    const customer = await api.createCustomer({
      first_name: 'QAScrollBulk',
      last_name: `Customer${runId}`,
      email: `qa-scroll-bulk-${runId}-${stamp}@e2e-qa.invalid`,
      phone: `555${String(stamp).slice(-7)}`,
    });
    const location = await api.addLocation(customer.id, {
      address_line1: '100 QA Scroll Way',
      city: 'Austin',
      state: 'TX',
      zip: '78749',
      is_primary: true,
    });
    const { res: jobRes, body: jobBody } = await api.createJob({
      customer_id: customer.id,
      service_location_id: location.id,
    });
    expect(jobRes.ok(), `seed job failed: ${jobRes.status()} ${JSON.stringify(jobBody)}`).toBeTruthy();
    const jobNumber: string = jobBody.job.job_number;

    await page.goto('/jobs');

    const checkbox = page.getByRole('checkbox', { name: `Select ${jobNumber}` });
    const visible = await checkbox.isVisible({ timeout: 20_000 }).catch(() => false);
    if (!visible) {
      // eslint-disable-next-line no-console
      console.log(`[qa-scroll] /jobs never rendered the seeded row (checkbox "Select ${jobNumber}" not found in 20s) — bulkBar surface unreachable in this environment.`);
      test.skip(true, `seeded job ${jobNumber} row / its selection checkbox never appeared on /jobs — bulkBar surface unreachable in this environment, point 4 NOT verified`);
      return;
    }
    await checkbox.check();

    const assignBtn = page.getByRole('button', { name: 'Assign' });
    const assignVisible = await assignBtn.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!assignVisible) {
      test.skip(true, 'the "Assign" bulk-action button never appeared after selecting a job row — bulkBar surface unreachable (ability gate?), point 4 NOT verified');
      return;
    }
    await assignBtn.click();

    const panel = page.locator('[data-slot="popover-content"]').filter({ has: page.getByPlaceholder('Search people...') });
    await expect(panel).toBeVisible({ timeout: 10_000 });
    const list = panel.locator('[data-slot="command-list"]');
    await expect(list).toBeVisible();

    const { scrollHeight, clientHeight } = await list.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));

    if (scrollHeight <= clientHeight) {
      // Not enough assignable techs referenced-in-jobs to overflow this particular list —
      // still confirm the surface renders and is interactive (unaffected, not broken), and
      // say plainly that the genuine-wheel-scroll proof does not apply here.
      await expect(list.locator('[data-slot="command-item"]').first()).toBeVisible();
      // eslint-disable-next-line no-console
      console.log(
        `[qa-scroll] bulkBar list did NOT overflow (scrollHeight=${scrollHeight} clientHeight=${clientHeight}) ` +
          '— reached and rendered fine, but no genuine wheel-scroll proof was possible here.',
      );
    } else {
      const beforeScrollTop = await list.evaluate((el) => el.scrollTop);
      const box = await list.boundingBox();
      if (!box) throw new Error('bulkBar list has no bounding box');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 400);
      await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(beforeScrollTop);
      const afterScrollTop = await list.evaluate((el) => el.scrollTop);
      // eslint-disable-next-line no-console
      console.log(
        `[qa-scroll] bulkBar list scrollHeight=${scrollHeight} clientHeight=${clientHeight} ` +
          `scrollTop before=${beforeScrollTop} after=${afterScrollTop} — native scroll works unmodified outside a modal, as expected.`,
      );
    }

    await page.keyboard.press('Escape').catch(() => {});
    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-scroll-4-bulkbar');
    await screenshotAndAssert(page, 'qa-scroll-02-bulkbar-assign.png');
  });
});
