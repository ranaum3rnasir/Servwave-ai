import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { InvoicesTab, type CustomerInvoice } from '../detailTabs';

// ─── The discriminating fixture ──────────────────────────────────────────────
//
// #1822: the tab decided "overdue" by comparing raw INSTANTS (`new Date(due) <
// new Date()`) and rendered the day in the VIEWER's zone, while the invoices
// list next door was already on the ORG's calendar clock. Two zones on opposite
// sides of UTC are needed to pull those two defects apart:
//
//   - the OLD PREDICATE is viewer-zone INDEPENDENT (it compares absolute
//     instants), so what breaks it is a `now` PAST the due instant but still on
//     the same org calendar DAY;
//   - the OLD RENDERER (`toLocaleDateString()` with no `timeZone`) IS
//     viewer-zone dependent, so the viewer zone must be pinned and must differ
//     from the org zone.
//
// DUE is 7:00 PM Aug 6 in Los Angeles but 10:00 AM Aug 7 in Manila.
// NOW is 10:00 PM Aug 6 in Los Angeles - later than DUE, SAME org day.
const ORG = 'America/Los_Angeles'; // PDT, UTC-7 in August
const VIEWER = 'Asia/Manila'; // UTC+8, deliberately the opposite sign
const DUE = '2026-08-07T02:00:00.000Z';
const NOW = '2026-08-07T05:00:00.000Z';

// The regression pins below deliberately use ZONE-NEUTRAL instants instead: a UTC hour
// between 07:00 and 15:00 lands on the same calendar day in Los Angeles (UTC-7) AND in
// Manila (UTC+8), so those tests render identical text and identical treatment under the
// old implementation and the new one. That is the point - they are pins, not proof.
/** Five org-days before NOW, and the same calendar day in both zones. */
const DUE_LONG_PAST = '2026-08-01T12:00:00.000Z';
const DUE_NEUTRAL_2 = '2026-08-02T12:00:00.000Z';
const DUE_NEUTRAL_3 = '2026-08-03T12:00:00.000Z';

// `useScheduleTimezone()` reads `org.timezone` through this module. Mock shape
// copied from `components/filters/controls/DateFacet.test.tsx:29-39`. Reading
// the outer `ORG` is safe ONLY because the read is deferred inside the
// `useOrganization` arrow, which runs at render time - long after this module
// body. Flattening it to a bare literal at factory level would be a TDZ
// ReferenceError.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({
      data: { id: 'org-1', timezone: ORG },
      isLoading: false,
      isError: false,
    }),
  };
});

function invoice(over: Partial<CustomerInvoice> = {}): CustomerInvoice {
  return {
    id: 'inv-1',
    invoice_number: 'INV-1001',
    status: 'SENT',
    kind: 'STANDARD',
    total_amount: 100,
    amount_due: 100,
    due_date: DUE,
    created_at: '2026-07-01T12:00:00.000Z',
    job_number: 'J00001',
    job_id: 'job-1',
    payments: [],
    ...over,
  } as CustomerInvoice;
}

beforeEach(() => {
  // `vi.stubEnv` rather than a manual save/restore: a saved `undefined` restores
  // the LITERAL string "undefined", which Node reads as UTC and which then
  // poisons every later file sharing this worker.
  vi.stubEnv('TZ', VIEWER);
  // A vacuous pin would let the render assertion in Test 1 pass under the OLD
  // code too, since the OLD renderer is the one thing the viewer zone moves.
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(VIEWER);

  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('InvoicesTab renders the due date on the org clock (#1822)', () => {
  // ─── THE ONLY GENUINE RED/GREEN FOR #1822 ──────────────────────────────────
  // Old code: `new Date(DUE) < new Date(NOW)` is true -> softRed pill reading
  //           "Aug 7, 2026" (the Manila day).
  // New code: `orgDayDiff(DUE, ORG) === 0`, so not overdue -> muted text reading
  //           "Aug 6, 2026" (the Los Angeles day).
  // Both the day NUMBER and the treatment flip, and the assertion exercises the
  // predicate, the renderer and the hook wiring together - a correct predicate
  // the component never actually calls would still pass a pure unit test.
  it('does not flag an invoice due later today on the org clock as overdue', () => {
    renderWithProviders(<InvoicesTab invoices={[invoice()]} />);

    const cell = screen.getByText('Aug 6, 2026');
    expect(cell).toBeInTheDocument();
    // `bg-status-red-subtle` is the softRed pill (ui-kit/components/ui/badge.tsx:29).
    expect(cell.className).not.toContain('bg-status-red-subtle');
    expect(cell.className).toContain('text-muted-foreground');

    // The viewer's calendar day must not appear anywhere in the table.
    expect(screen.queryByText('Aug 7, 2026')).toBeNull();
  });

  // NOT DISCRIMINATING FOR #1822 - passes under both the old and the new
  // implementation. It exists only to guard the OPPOSITE regression: a "fix"
  // that simply stopped flagging anything overdue would pass Test 1 and fail
  // this one.
  it('still flags an invoice five org-days past due', () => {
    renderWithProviders(
      <InvoicesTab invoices={[invoice({ due_date: DUE_LONG_PAST })]} />,
    );

    const cell = screen.getByText('Aug 1, 2026');
    expect(cell.className).toContain('bg-status-red-subtle');
  });

  // NOT DISCRIMINATING FOR #1822 - the status guard is untouched by this fix.
  // Pinned so a later refactor of the predicate cannot quietly widen it beyond
  // the two payable statuses.
  it('never flags DRAFT, PAID or VOIDED invoices, however far past due', () => {
    renderWithProviders(
      <InvoicesTab
        invoices={[
          invoice({ id: 'a', invoice_number: 'INV-A', status: 'DRAFT', due_date: DUE_LONG_PAST }),
          invoice({ id: 'b', invoice_number: 'INV-B', status: 'PAID', amount_due: 0, due_date: DUE_NEUTRAL_2 }),
          invoice({ id: 'c', invoice_number: 'INV-C', status: 'VOIDED', due_date: DUE_NEUTRAL_3 }),
        ]}
      />,
    );

    for (const day of ['Aug 1, 2026', 'Aug 2, 2026', 'Aug 3, 2026']) {
      const cell = screen.getByText(day);
      expect(cell.className).not.toContain('bg-status-red-subtle');
      expect(cell.className).toContain('text-muted-foreground');
    }
  });

  // NOT DISCRIMINATING FOR #1822 - passes under both implementations. It guards
  // the NEW `!!` narrowing: a null due date must still short-circuit to the dash
  // and must never reach the formatter as "Invalid Date". The fixture carries a
  // real `job_number` on purpose - the Job # cell renders '-' too when it is
  // null (detailTabs.tsx:402), which would make a bare `getByText('-')`
  // ambiguous.
  it('renders a dash, not "Invalid Date", when the due date is null', () => {
    renderWithProviders(
      <InvoicesTab invoices={[invoice({ due_date: null, job_number: 'J00001' })]} />,
    );

    expect(screen.queryByText(/Invalid Date/)).toBeNull();
    expect(screen.getByText('J00001')).toBeInTheDocument();
    expect(screen.getAllByText('-')).toHaveLength(1);
  });
});
