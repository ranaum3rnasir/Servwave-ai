/**
 * Payments go-live slice 24 (#1073) - the routed public invoice page shows the homeowner what they
 * are paying for: the contractor's name and logo, the scope of work, and the amount due.
 *
 * The scope blocks arrive on the public payload with their customer-safe fields only (backend
 * `toPublicScopes`); their flat prices are already inside the stored subtotal, so the printed
 * blocks and lines reconcile with the Subtotal under them. Checked at desktop width and below sm
 * (a 320 px phone), where the line items are stacked rows rather than a table.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicInvoicePage from '../PublicInvoicePage';

const PRICED_SCOPE = {
  id: 'scope-a', title: 'Panel upgrade', body: 'Replace the 100A panel with a 200A panel.', flat_price: '1200.00', is_taxable: true,
};
const NARRATIVE_SCOPE = {
  id: 'scope-b', title: 'Permit handling', body: 'We file the city permit and book the inspection.', flat_price: null, is_taxable: false,
};
const LINE = { id: 'li-1', sequence: 1, description: 'Service call', quantity: 1, unit_price: 300, is_taxable: true, line_total: 300 };

function payload(invoice: Record<string, unknown> = {}, organization: Record<string, unknown> = {}) {
  return {
    invoice: {
      id: 'inv-sow-1', invoice_number: 'I00024', status: 'SENT', kind: 'INVOICE',
      subtotal: 1500, discount_amount: 0, tax_amount: 0, deposit_credit: 0, total_amount: 1500, amount_due: 1500,
      due_date: null, sent_at: '2026-03-01T00:00:00.000Z', paid_at: null, created_at: '2026-03-01T00:00:00.000Z',
      job: null,
      customer: { first_name: 'Pat', last_name: 'Payer', company_name: null },
      line_items: [LINE],
      scopes: [PRICED_SCOPE, NARRATIVE_SCOPE],
      payments: [],
      ...invoice,
    },
    organization: { name: 'Neutral Home Services', logo_url: null, brand_color: null, ...organization },
    available_payment_methods: ['CARD'],
    payment_instructions: {},
  };
}

/** Answer below sm (max-width: 639px) as a 320 px phone would, everything else as the default. */
function phoneWidth(isPhone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isPhone && /max-width:\s*639/.test(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function open(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
  return renderWithProviders(<PublicInvoicePage />, { initialEntries: ['/p/invoices/inv-sow-1?token=tok-24'] });
}

afterEach(() => {
  vi.unstubAllGlobals();
  phoneWidth(false);
});

describe.each([
  ['desktop', false],
  ['a 320 px phone', true],
])('public invoice scope of work, at %s', (_width, isPhone) => {
  it('lists every scope block in stored order with its title, body and price; an unpriced block shows no amount', async () => {
    phoneWidth(isPhone);
    open(payload());

    const section = await screen.findByRole('region', { name: 'Scope of work' });
    const blocks = within(section).getAllByRole('listitem');
    expect(blocks).toHaveLength(2);
    const [priced, narrative] = blocks as [HTMLElement, HTMLElement];

    expect(within(priced).getByText('Panel upgrade')).toBeInTheDocument();
    expect(within(priced).getByText('Replace the 100A panel with a 200A panel.')).toBeInTheDocument();
    expect(within(priced).getByText('$1,200.00')).toBeInTheDocument();

    expect(within(narrative).getByText('Permit handling')).toBeInTheDocument();
    expect(within(narrative).getByText('We file the city permit and book the inspection.')).toBeInTheDocument();
    // Blank, never $0.00: the work is described, not separately priced.
    expect(narrative.textContent).not.toMatch(/\$/);

    // The invoice's own line still prints beside the scope, and the amount due is on the page.
    expect(screen.getByText('Service call')).toBeInTheDocument();
    expect(screen.getAllByText('$1,500.00').length).toBeGreaterThan(0);
  });

  it('a scope-only invoice shows its scope and never says "No line items"', async () => {
    phoneWidth(isPhone);
    open(payload({ line_items: [], scopes: [PRICED_SCOPE], subtotal: 1200, total_amount: 1200, amount_due: 1200 }));

    expect(await screen.findByText('Panel upgrade')).toBeInTheDocument();
    expect(screen.queryByText('No line items')).not.toBeInTheDocument();
  });

  it('an invoice with no scope renders no scope section', async () => {
    phoneWidth(isPhone);
    const { unmount } = open(payload({ scopes: [] }));
    expect(await screen.findByText('Service call')).toBeInTheDocument();
    expect(screen.queryByText(/scope of work/i)).not.toBeInTheDocument();
    unmount();

    // A payload from before slice 24 carries no scopes key at all.
    const old = payload();
    delete (old.invoice as Record<string, unknown>).scopes;
    open(old);
    expect(await screen.findByText('Service call')).toBeInTheDocument();
    expect(screen.queryByText(/scope of work/i)).not.toBeInTheDocument();
  });
});

// Conductor note on slice 24 (from slice 05's staging check): a JOB invoice whose lines belong to
// the invoice itself printed "No line items", because the page read a job invoice's lines only
// from the job's estimate. The invoice's own lines are what it bills; the estimate's lines are the
// fallback only for a legacy invoice that has neither lines of its own nor scope blocks.
const JOB = {
  job_number: 'J00024',
  estimate: null,
  customer: { first_name: 'Pat', last_name: 'Payer', company_name: null },
  service_location: { city: 'Testville', state: 'MA', zip: '02108' },
};
const ESTIMATE = {
  estimate_number: 'E00024', discount_name: null, discount_type: null, discount_value: null, tax_rate: 0,
  line_items: [{ id: 'est-li-1', sequence: 1, description: 'Quoted door install', quantity: 1, unit_price: 900, is_taxable: true, line_total: 900 }],
};

describe('public invoice on a job - which lines it prints', () => {
  it("prints a job invoice's own lines", async () => {
    open(payload({ job: JOB, customer: null, scopes: [] }));

    expect(await screen.findByText('Service call')).toBeInTheDocument();
    expect(screen.queryByText('No line items')).not.toBeInTheDocument();
  });

  it("prints the invoice's own lines, not the estimate's, when it has both", async () => {
    open(payload({ job: { ...JOB, estimate: ESTIMATE }, customer: null, scopes: [] }));

    expect(await screen.findByText('Service call')).toBeInTheDocument();
    expect(screen.queryByText('Quoted door install')).not.toBeInTheDocument();
  });

  it("falls back to the estimate's lines when the invoice has none of its own", async () => {
    open(payload({ job: { ...JOB, estimate: ESTIMATE }, customer: null, line_items: [], scopes: [] }));

    expect(await screen.findByText('Quoted door install')).toBeInTheDocument();
  });

  // Conductor ruling on slice 24: the customer page never prints a line that is not part of the
  // invoice's total. A scope-only job invoice's subtotal is its priced scope blocks, so neither the
  // job's estimate lines nor its charges may print beside them.
  it('a scope-only job invoice prints no estimate lines or job charges', async () => {
    const CHARGE = { id: 'charge-1', sequence: 1, description: 'Trip charge', quantity: 1, unit_price: 75, is_taxable: false, line_total: 75 };
    open(payload({
      job: { ...JOB, estimate: ESTIMATE, charges: [CHARGE] },
      customer: null,
      line_items: [],
      scopes: [PRICED_SCOPE, NARRATIVE_SCOPE],
      subtotal: 1200, total_amount: 1200, amount_due: 1200,
    }));

    const section = await screen.findByRole('region', { name: 'Scope of work' });
    expect(screen.queryByText('Quoted door install')).not.toBeInTheDocument();
    expect(screen.queryByText('Trip charge')).not.toBeInTheDocument();
    expect(screen.queryByText('No line items')).not.toBeInTheDocument();

    // Every amount printed above the totals - scope prices plus any line totals - adds up to the
    // Subtotal the page shows.
    const money = (text: string | null | undefined) => Number((text ?? '').replace(/[^0-9.-]/g, ''));
    const scopePrices = within(section).queryAllByText(/^\$[\d,]+\.\d{2}$/).map((el) => money(el.textContent));
    const lineTotals = (screen.queryByRole('table')
      ? within(screen.getByRole('table')).getAllByRole('row').slice(1).map((r) => money(r.lastElementChild?.textContent))
      : []);
    const subtotalRow = within(screen.getByTestId('public-invoice-totals')).getByText('Subtotal').parentElement!;
    const shownSubtotal = money(subtotalRow.lastElementChild?.textContent);

    expect(shownSubtotal).toBe(1200);
    expect([...scopePrices, ...lineTotals].reduce((sum, n) => sum + n, 0)).toBe(shownSubtotal);
  });
});

// Story 51: the homeowner sees whose invoice this is - the contractor's logo, or its name when it
// has none - at the top of the page, before the document.
describe('public invoice branding', () => {
  it("shows the contractor's logo, named for the business", async () => {
    open(payload({}, { logo_url: 'https://cdn.example.test/logo.png' }));

    const banner = await screen.findByRole('banner');
    const logo = within(banner).getByRole('img', { name: 'Neutral Home Services' });
    expect(logo).toHaveAttribute('src', 'https://cdn.example.test/logo.png');
  });

  it("shows the contractor's name when it has no logo", async () => {
    open(payload());

    const banner = await screen.findByRole('banner');
    expect(within(banner).getByText('Neutral Home Services')).toBeInTheDocument();
    expect(within(banner).queryByRole('img')).not.toBeInTheDocument();
  });
});

// Conductor note on slice 24: the service address "showed no street". The public payload carries
// the city, state and zip only (F-55 keeps the street lines off the token route), so the page
// prints that line and no blank line where a street would be.
describe('public invoice service address', () => {
  it('prints the city line with no blank street line above it', async () => {
    open(payload({ job: JOB, customer: null, scopes: [] }));

    const label = await screen.findByText('Service Address');
    const block = label.parentElement!;
    expect(within(block).getByText('Testville, MA 02108')).toBeInTheDocument();
    const lines = Array.from(block.querySelectorAll('p')).filter((p) => p !== label);
    expect(lines.map((p) => p.textContent?.trim())).toEqual(['Testville, MA 02108']);
  });
});
