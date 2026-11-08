/**
 * #1821 - the PUBLIC invoice page (`/p/invoices/:id`, the surface a CUSTOMER sees)
 * decided both the printed due date and the overdue banner from the VIEWER's browser
 * zone and a raw-instant comparison. This is the one surface whose viewer zone is
 * genuinely unknown, so a browser-clock render there is at its most damaging: a
 * customer east of the business is told an invoice is overdue on a day the business
 * still considers current, and reads a due date one day off the one printed on the
 * owner's own detail page for the same record.
 *
 * THE DISCRIMINATOR: the viewer zone must OPPOSE the org zone. TZ is pinned to
 * Asia/Manila (UTC+8) while the org sits in America/New_York (UTC-4 in July) - the
 * offsets point opposite ways, so a fixed-direction offset bug cannot satisfy both,
 * and a test where viewer == org would pass under the old code too. Same rationale as
 * `pages/v2/invoices/__tests__/invoiceListDueDateZone.test.tsx:9-13`.
 *
 * `vi.stubEnv`, NOT a manual save/restore: TZ is normally unset, and assigning the
 * saved `undefined` back writes the STRING "undefined", which Node reads as an invalid
 * zone and silently falls back to UTC - poisoning the ambient zone for every later test
 * file in the same worker. See `__tests__/date-only-rendering.test.tsx:73-76`.
 * (`invoiceListDueDateZone.test.tsx:57-61` uses the manual form; that half is
 * deliberately not copied.)
 *
 * Assertions read `container.textContent`, never `getByText`: every date is a bare text
 * node beside a sibling `<span>` (`<span>Due: </span>{date}`), so no element's
 * textContent equals the date alone, and `PublicNotice`
 * (`../components/publicShell.tsx:58-63`) wraps its children in two nested `<div>`s
 * with no role, so a substring regex matches the `<p>` AND both ancestors.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { formatInstant, ORG_DAY_FORMAT } from '@/lib/schedule-tz';

import PublicInvoicePage from '../PublicInvoicePage';

const NY = 'America/New_York';   // ServWave Test, Northwind Services
const DENVER = 'America/Denver'; // Riverbend Septic
const MANILA = 'Asia/Manila';    // the VIEWER - opposite-offset discriminator

// Staging invoice I00118, the canonical fixture (`lib/invoices/invoiceDueDate.test.ts:16-19`).
// 02:35 UTC on 7/11 is 22:35 on 7/10 in New York, but 10:35 on 7/11 in Manila. The ORG day
// is the 10th; only a viewer-zone render says the 11th.
const I00118_DUE = '2026-07-11T02:35:09.368Z';

// 00:30 on 7/11 in New York, but 22:30 on 7/10 in Denver. I00118_DUE canNOT do this job:
// 02:35Z is 7/10 in BOTH New York and Denver, so an implementation that ignored
// `organization.timezone` entirely and hardcoded DEFAULT_SCHEDULE_TIMEZONE would pass a
// Denver test built on it. This instant is the only shape that separates a Denver org
// from the New York fallback.
const DENVER_SPLIT = '2026-07-11T04:30:00Z'; // NY 7/11 · Denver 7/10 · Manila 7/11

// Control instant: 13:00 UTC is 09:00 on 7/10 in New York and 21:00 on 7/10 in Manila -
// the SAME calendar day in both zones.
const CONTROL_INSTANT = '2026-07-10T13:00:00.000Z';

// 23:00 on 7/10 Eastern: PAST the due instant, but still the org's due DAY. The old raw
// -instant predicate fires the overdue banner here; the calendar-day predicate must not.
const NOW_SAME_ORG_DAY = '2026-07-11T03:00:00Z';
// Two org days after the due day - the banner is genuinely owed here, under both
// implementations. Only its printed DAY differs.
const NOW_TWO_DAYS_LATER = '2026-07-12T12:00:00Z';

type PublicOrg = Record<string, unknown> | null;

function buildPayload(invoiceOverrides: Record<string, unknown>, organization: PublicOrg) {
  return {
    invoice: {
      id: 'i1',
      invoice_number: 'I00001',
      status: 'SENT',
      kind: 'INVOICE',
      subtotal: 100,
      discount_amount: 0,
      tax_amount: 0,
      deposit_credit: 0,
      total_amount: 100,
      amount_due: 100,
      due_date: null,
      sent_at: null,
      paid_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      customer: null,
      line_items: [
        {
          id: 'l1',
          sequence: 1,
          description: 'Work',
          quantity: 1,
          unit_price: 100,
          is_taxable: false,
          line_total: 100,
        },
      ],
      job: null,
      payments: [],
      ...invoiceOverrides,
    },
    organization,
    available_payment_methods: ['CHECK'],
    payment_instructions: { check: 'Mail it' },
    service_fee_preview: 0,
  };
}

/**
 * The `?token=` is MANDATORY - without it the page short-circuits to `PublicUnavailable`
 * before it ever fetches (`../PublicInvoicePage.tsx:204-206`).
 */
async function renderPage(
  invoiceOverrides: Record<string, unknown> = {},
  organization: PublicOrg = { name: 'Acme', timezone: NY },
): Promise<HTMLElement> {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => buildPayload(invoiceOverrides, organization),
    }),
  );
  const { container } = renderWithProviders(<PublicInvoicePage />, {
    initialEntries: ['/p/invoices/i1?token=t'],
  });
  await waitFor(() => expect(container.textContent).toContain('I00001'));
  return container;
}

beforeAll(() => {
  vi.stubEnv('TZ', MANILA);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // If this ever fails the whole file is vacuous: an un-pinned viewer zone that happens
  // to equal the org zone passes under the OLD code as well as the new.
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(MANILA);
  // shouldAdvanceTime is REQUIRED: the component resolves a `fetch` promise and RTL's
  // waitFor needs timers to advance or the render never settles.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW_TWO_DAYS_LATER));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('#1821 - the public invoice page renders on the ORG clock', () => {
  // ── 1 · DISCRIMINATING ────────────────────────────────────────────────────
  it('prints the "Due:" line on the org calendar day, not the viewer\'s', async () => {
    const container = await renderPage({ due_date: I00118_DUE });

    expect(container.textContent).toContain('Due: 7/10/2026');
    expect(container.textContent).not.toContain('7/11/2026');
  });

  // ── 2 · DISCRIMINATING - the sharpest test in the file ────────────────────
  // It pins the PREDICATE rather than the rendering, so it fails the old code even from
  // New York: the old gate was a raw-instant compare and therefore viewer-zone
  // independent. 02:35:09Z is 22:35 on 7/10 Eastern; 03:00Z is 23:00 on 7/10 Eastern.
  // Old: `Date(02:35Z) < Date(03:00Z)` -> banner SHOWN, telling the customer he is late
  // on the very day the invoice fell due. New: orgDayDiff === 0 -> absent.
  it('shows NO overdue banner while the org is still on the due day', async () => {
    vi.setSystemTime(new Date(NOW_SAME_ORG_DAY));

    const container = await renderPage({ due_date: I00118_DUE });

    expect(container.textContent).not.toContain('This invoice was due on');
  });

  // ── 3 · DISCRIMINATING ────────────────────────────────────────────────────
  it('names the org calendar day when the overdue banner IS owed', async () => {
    const container = await renderPage({ due_date: I00118_DUE });

    expect(container.textContent).toContain('This invoice was due on 7/10/2026');
  });

  // ── 4 · DISCRIMINATING ────────────────────────────────────────────────────
  // A bundle cached from before the API deploy receives no `timezone` key.
  it('falls back to a FIXED named zone when organization.timezone is absent', async () => {
    const container = await renderPage({ due_date: I00118_DUE }, { name: 'Acme' });

    expect(container.textContent).toContain('Due: 7/10/2026');
    expect(container.textContent).not.toContain('7/11/2026');
  });

  // ── 5 · DISCRIMINATING ────────────────────────────────────────────────────
  it('falls back to the same fixed zone - and does not crash - when organization is null', async () => {
    const container = await renderPage({ due_date: I00118_DUE }, null);

    expect(container.textContent).toContain('Due: 7/10/2026');
    expect(container.textContent).not.toContain('7/11/2026');
  });

  // ── 6 · DISCRIMINATING - the per-org threading test ───────────────────────
  // DENVER_SPLIT is 7/11 in New York and 7/10 in Denver. The Denver half fails both the
  // old browser-clock code AND any implementation that reads a hardcoded
  // DEFAULT_SCHEDULE_TIMEZONE instead of the org's own field; the New York half is the
  // contrast that shows the difference comes from `organization.timezone`.
  it('threads the ORG\'s own zone, not one hardcoded default', async () => {
    const denver = await renderPage({ due_date: DENVER_SPLIT }, { name: 'Acme', timezone: DENVER });

    expect(denver.textContent).toContain('Due: 7/10/2026');
    expect(denver.textContent).not.toContain('7/11/2026');

    const newYork = await renderPage({ due_date: DENVER_SPLIT }, { name: 'Acme', timezone: NY });

    expect(newYork.textContent).toContain('Due: 7/11/2026');
    expect(newYork.textContent).not.toContain('7/10/2026');
  });

  // ── 7 · DISCRIMINATING ────────────────────────────────────────────────────
  // Fixtures are deliberately DUE-shaped (00:00-03:59Z). With CONTROL_INSTANT this test
  // would silently pass under both implementations and the "convert every date field in
  // one change" argument would go unguarded - leaving one document showing "Sent:" on the
  // customer's clock beside "Due:" on the business's, a day apart from each other.
  it('renders sent_at, paid_at and payments[].paid_at on the org day too', async () => {
    const container = await renderPage({
      status: 'PAID',
      amount_due: 0,
      sent_at: I00118_DUE,
      paid_at: I00118_DUE,
      payments: [{ id: 'p1', amount: 100, method: 'CHECK', paid_at: I00118_DUE }],
    });

    expect(container.textContent).toContain('Sent: 7/10/2026');
    expect(container.textContent).toContain('Paid 7/10/2026');
    expect(container.textContent).toContain('Check - 7/10/2026');
    expect(container.textContent).not.toContain('7/11/2026');
  });

  // ── 8 · NOT DISCRIMINATING - control, by design ───────────────────────────
  // CONTROL_INSTANT falls on 7/10 in BOTH New York and Manila, so no implementation can
  // be told apart by it. It passes before and after the fix and proves NOTHING about
  // #1821; it exists to show that tests 1-7 are red for the timezone reason and not for
  // some unrelated harness fault.
  it('control: an instant that falls on one day in both zones is unaffected', async () => {
    const container = await renderPage({ due_date: CONTROL_INSTANT });

    expect(container.textContent).toContain('Due: 7/10/2026');
  });

  // ── 9 · NOT DISCRIMINATING - null-path regression guard ───────────────────
  // `formatInstant` returns '' for null, so the `{invoice.due_date && ...}` guards must
  // survive the change or the page renders a bare "Due: " label with nothing after it.
  // Passes under both implementations.
  it('regression guard: no due_date means no "Due:" line and no banner', async () => {
    const container = await renderPage({ due_date: null });

    expect(container.textContent).not.toContain('Due:');
    expect(container.textContent).not.toContain('This invoice was due on');
  });

  // ── ACCEPTANCE BAR ────────────────────────────────────────────────────────
  // Welded to the internal detail page's live expression rather than to a literal, so the
  // customer's copy and the business's copy stay in lockstep if the format is restyled.
  // `pages/v2/invoices/InvoiceDetailPage.tsx:582` is
  // `Due {formatInstant(invoice.due_date, timeZone, ORG_DAY_FORMAT)}`.
  it('prints the byte-identical due day the BUSINESS sees on the internal detail page', async () => {
    const container = await renderPage({ due_date: I00118_DUE });

    expect(container.textContent).toContain(`Due: ${formatInstant(I00118_DUE, NY, ORG_DAY_FORMAT)}`);
  });
});
