// Example scenario script: B7 lead notes (PR #3055, tickets #3034-#3037), as recorded on staging.
// Copy this next to record-kit.js in the scratchpad and replace the scenarios with the PR's own.
// Run: node example-b7.js <output folder>
const { startRecording, caption, openTab, typeAndConfirm, showEvidence, runTag } = require('./record-kit');

(async () => {
  const outDir = process.argv[2] || './proof-out';
  const { page, check, log, finish, base } = await startRecording({ outDir });
  const tag = runTag();
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  try {
    // A fresh test lead with no walkthrough. Unique per run (mistake 7), clearly marked as a test.
    await page.goto(base + '/leads/new', { waitUntil: 'networkidle' });
    await caption(page, `B7 on staging, ${stamp}: create a test lead with no walkthrough`);
    await page.fill('#v2-first-name', 'B7 Video');
    await page.fill('#v2-last-name', `Test ${tag}`);
    await page.getByPlaceholder('Email address').fill(`b7-video-${tag}@e2e-qa.invalid`);
    await page.locator('#v2-service-request').fill('B7 lead notes video check (test lead, safe to delete)');
    await page.getByRole('button', { name: 'Create Lead' }).click();
    await page.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 30000 });
    log.push('created lead ' + page.url());
    await page.getByRole('tab', { name: 'Notes' }).waitFor({ timeout: 30000 });

    // #3034: tab order.
    const tabs = await page.$$eval('[role=tab]', (els) => els.map((e) => e.textContent.trim().replace(/\s*\(\d+\)$/, '')));
    check(tabs.join('|') === 'Overview|Walkthrough|Estimates|Attachments|Communication|Tasks|Notes', '#3034 tabs end with Notes, after Tasks');
    await caption(page, '#3034: the lead now has a Notes tab, last, after Tasks');

    // #3035: the booking box is open and its notes go with the booking.
    await openTab(page, 'Walkthrough');
    const box = page.locator('#v2-wt-booking-notes');
    await box.waitFor({ timeout: 20000 });
    check((await box.isVisible()) && (await box.isEnabled()), '#3035 "Walkthrough notes" box is open on a lead with no walkthrough');
    await caption(page, '#3035: on a new lead the "Walkthrough notes" box is open (it used to be grey)');
    const n1 = 'Customer says the left track looks bent. Bring the spring gauge.';
    await book(page, '11/10/2026', n1, check);
    await page.getByRole('button', { name: 'Schedule Walkthrough' }).click();
    await page.getByRole('button', { name: 'Book Another Visit' }).waitFor({ timeout: 20000 });

    // #3037: no notes box once booked.
    check((await page.locator('#v2-wt-booking-notes').count()) === 0, '#3037 no notes box on the Walkthrough tab once booked');
    await caption(page, '#3037: once booked, the Walkthrough tab has no notes box');

    // #3036: the card carries the booking notes; #3034: add a lead note.
    await openTab(page, 'Notes');
    const card1 = page.getByLabel('Walkthrough 1 notes');
    await card1.waitFor({ timeout: 20000 });
    check((await card1.inputValue()).includes(n1), '#3036 "Walkthrough 1" card shows the notes typed while booking');
    await showEvidence(page, page.locator('#walkthrough-notes-heading'), '#3036: a "Walkthrough 1" card with the booking notes');
    const note = 'Lead note from the B7 video check.';
    await typeAndConfirm(page.getByRole('textbox', { name: 'Note', exact: true }), note, check);
    await page.getByRole('button', { name: 'Add Note' }).click();
    await page.getByText(note).first().waitFor({ timeout: 20000 });
    check(true, '#3034 the added lead note shows in the list');
    await showEvidence(page, page.getByText(note).first(), '#3034: "Add note" adds a lead note with its author and time');

    // #3036: edit and save a card.
    const extra = ' Gate code 4521.';
    await card1.click();
    await page.keyboard.press('End');
    await card1.pressSequentially(extra, { delay: 25 });
    await caption(page, '#3036: "Save Notes" appears once something is typed');
    await page.getByRole('button', { name: 'Save Notes' }).first().click();
    await page.waitForTimeout(2500);

    // #3035: "Book Another Visit" has its own box (and starts with no performer for an Admin: mistake 8).
    await openTab(page, 'Walkthrough');
    await page.getByRole('button', { name: 'Book Another Visit' }).click();
    const n2 = 'Second trip: measure for the new opener.';
    await caption(page, '#3035: "Book Another Visit" has the same "Walkthrough notes" box');
    await book(page, '11/12/2026', n2, check);
    await page.getByRole('button', { name: 'Book Visit' }).click();
    await page.waitForTimeout(4000);

    // After a reload: both cards, newest first, each with its own notes.
    await page.reload({ waitUntil: 'networkidle' });
    await openTab(page, 'Notes');
    await page.getByLabel('Walkthrough 2 notes').waitFor({ timeout: 20000 });
    check((await page.getByLabel('Walkthrough 2 notes').inputValue()).includes(n2), '#3036 "Walkthrough 2" card carries the extra visit\'s notes (after reload)');
    check((await page.getByLabel('Walkthrough 1 notes').inputValue()).includes(n1 + extra), '#3036 the saved edit survived a reload');
    const order = await page.$$eval('[aria-label$=" notes"]', (els) => els.map((e) => e.getAttribute('aria-label')));
    check(order.indexOf('Walkthrough 2 notes') < order.indexOf('Walkthrough 1 notes'), '#3036 cards are newest first');
    await showEvidence(page, page.locator('#walkthrough-notes-heading'), '#3036: after a reload, one card per walkthrough, newest first');
    await caption(page, 'B7 checked on staging: #3034, #3035, #3036, #3037');
  } catch (e) {
    log.push('ERROR ' + e.message);
    await page.screenshot({ path: outDir + '/fail.png' }).catch(() => {});
  } finally {
    await finish();
  }
})();

/** Fills the booking form: every field explicitly (mistake 8), then the notes, confirmed (mistake 5). */
async function book(page, date, notes, check) {
  await page.fill('#v2-wt-start-date', date);
  await page.fill('#v2-wt-start-time', '10:00 AM');
  await page.fill('#v2-wt-end-date', date);
  await page.fill('#v2-wt-end-time', '11:00 AM');
  await page.keyboard.press('Tab');
  await page.click('#v2-wt-performers');
  await page.getByRole('option', { name: 'System Admin', exact: true }).click();
  await page.keyboard.press('Escape');
  await typeAndConfirm(page.locator('#v2-wt-booking-notes'), notes, check);
}
