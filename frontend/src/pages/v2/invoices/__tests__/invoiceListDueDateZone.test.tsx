/**
 * Defect B - the invoices LIST rendered its Due Date / Created cells with
 * `new Date(iso).toLocaleDateString()`, which resolves the instant against the
 * VIEWER's browser zone (and the runtime's default locale). `due_date` is a true
 * instant, so for any viewer east of the org it has already rolled into the next
 * calendar day and the column printed tomorrow - while the detail page, moved onto
 * the org clock by #1804, printed today. One invoice, two days, two screens.
 *
 * THE DISCRIMINATOR: the viewer zone must OPPOSE the org zone. `process.env.TZ` is
 * pinned to Asia/Manila (UTC+8) while the org sits in America/New_York (UTC-4 in
 * July) - the offsets point opposite ways, so a fixed-direction offset bug cannot
 * satisfy both, and a test where viewer == org would pass under the old code too.
 * Same rationale as `lib/invoices/invoiceDueDate.test.ts:4-9`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CellContext } from '@tanstack/react-table';
import type { ReactElement } from 'react';

import { formatInstant, ORG_DAY_FORMAT } from '@/lib/schedule-tz';
import { buildInvoiceColumns, type InvoiceListItem } from '../invoicesColumns';

const NY = 'America/New_York';   // ServWave Test, Northwind Services
const DENVER = 'America/Denver'; // Riverbend Septic
const MANILA = 'Asia/Manila';    // the VIEWER - opposite-offset discriminator

// Staging invoice I00118 (ServWave Test), QA's repro and the canonical fixture at
// `invoiceDueDate.test.ts:16-19`. 02:35 UTC on 7/11 is 22:35 on 7/10 in New York and
// 20:35 on 7/10 in Denver, but 10:35 on 7/11 in Manila. The ORG day is the 10th;
// only a viewer-zone render says the 11th.
const I00118_DUE = '2026-07-11T02:35:09.368Z';
// Control instant: 13:00 UTC is 09:00 on 7/10 in New York and 21:00 on 7/10 in
// Manila - the SAME calendar day in both zones.
const CONTROL_INSTANT = '2026-07-10T13:00:00.000Z';

function cellFor(id: string, orgTz: string) {
  const col = buildInvoiceColumns([], () => {}, () => {}, orgTz).find((c) => c.id === id)!;
  // Every column in this file defines `cell` as a render function, never the
  // plain-string form the union type also allows.
  return col.cell as (ctx: CellContext<InvoiceListItem, unknown>) => ReactElement;
}

function ctx(inv: Partial<InvoiceListItem>): CellContext<InvoiceListItem, unknown> {
  return { row: { original: inv } } as unknown as CellContext<InvoiceListItem, unknown>;
}

let originalTz: string | undefined;

beforeEach(() => {
  originalTz = process.env.TZ;
  process.env.TZ = MANILA;
  // If this ever fails the whole file is vacuous: an un-pinned viewer zone that
  // happens to equal the org zone passes under the OLD code as well as the new.
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(MANILA);
});

afterEach(() => {
  // vitest.config.ts makes no per-file env isolation guarantee, and a leaked TZ
  // corrupts unrelated suites.
  process.env.TZ = originalTz;
});

describe('invoices Due Date column honours the org timezone', () => {
  it('renders the due date on the org calendar day, not the viewer\'s', () => {
    render(cellFor('due_date', NY)(ctx({ status: 'SENT', due_date: I00118_DUE })));

    expect(screen.getByText('7/10/2026')).toBeInTheDocument();
    expect(screen.queryByText('7/11/2026')).not.toBeInTheDocument();
  });

  it('agrees with the detail page for a Denver org too', () => {
    render(cellFor('due_date', DENVER)(ctx({ status: 'SENT', due_date: I00118_DUE })));

    expect(screen.getByText('7/10/2026')).toBeInTheDocument();
    expect(screen.queryByText('7/11/2026')).not.toBeInTheDocument();
  });

  // CONTROL - deliberately passes BEFORE and AFTER the fix. An instant that lands on
  // one calendar day in both zones cannot tell the two implementations apart; keeping
  // it here is what shows the tests above are genuinely discriminating.
  it('control: an instant that falls on one day in both zones is unaffected', () => {
    render(cellFor('due_date', NY)(ctx({ status: 'SENT', due_date: CONTROL_INSTANT })));

    expect(screen.getByText('7/10/2026')).toBeInTheDocument();
  });

  it('still renders a dash when the invoice has no due date', () => {
    render(cellFor('due_date', NY)(ctx({ status: 'DRAFT', due_date: null })));

    expect(screen.getByText('-')).toBeInTheDocument();
  });
});

describe('invoices Created column honours the org timezone', () => {
  it('renders the created day on the org calendar day, not the viewer\'s', () => {
    render(cellFor('created_at', NY)(ctx({ created_at: I00118_DUE })));

    expect(screen.getByText('7/10/2026')).toBeInTheDocument();
    expect(screen.queryByText('7/11/2026')).not.toBeInTheDocument();
  });
});

describe('the invoices list and the invoice detail page cannot disagree', () => {
  // The acceptance bar, welded to the live detail-page expression
  // (`InvoiceDetailPage.tsx:585`) rather than a literal, so the two surfaces stay
  // in lockstep if the format is ever restyled.
  it('renders the byte-identical day string the detail page renders', () => {
    const { container } = render(
      cellFor('due_date', NY)(ctx({ status: 'SENT', due_date: I00118_DUE })),
    );

    expect(container.textContent).toBe(formatInstant(I00118_DUE, NY, ORG_DAY_FORMAT));
  });
});
