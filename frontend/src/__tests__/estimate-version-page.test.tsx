/**
 * #2030 slice 3 — the read-only version page.
 *
 * A salesperson opens a past version and reads the whole document exactly as the customer
 * received it. Rendered by the SAME component the live estimate and the public page use, fed the
 * frozen view-model instead of the live one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import EstimateVersionPage from '@/pages/v2/estimates/EstimateVersionPage';
import { printedRowAmounts, printedTotal, sectionHeadings, sumAmounts } from './estimate-document-dom';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'est-1', version: '1' }) };
});

const FROZEN = {
  version: 1,
  trigger: 'SEND',
  sent_at: '2026-09-02T10:00:00Z',
  estimate_id: 'est-1',
  estimate_number: 'E00042',
  document: {
    customer: { first_name: 'Jane', last_name: 'Doe', company_name: null },
    view: {
      number: 'E00042',
      taxRate: 0,
      scopeNotes: 'Business hours only.',
      hasLineItems: true,
      hasScopes: true,
      rows: [
        {
          kind: 'line_item', key: 'li-1', title: 'Keypad', detail: null, itemType: 'MATERIAL',
          quantity: 1, unitPrice: 200, grossAmount: null, netAmount: 200, discounted: false,
          discountType: null, discountValue: null, discountAmount: null, imageUrl: null, photos: [],
        },
        {
          kind: 'scope', key: 'scope-1', title: 'Install 3 doors', detail: 'Three of them.',
          itemType: null, quantity: null, unitPrice: null, grossAmount: null, netAmount: 800,
          discounted: false, discountType: null, discountValue: null, discountAmount: null,
          imageUrl: null,
          photos: [{ id: 'sp-1', url: 'https://signed.test/1.jpg', caption: 'Frame' }],
        },
      ],
      totals: [
        { kind: 'subtotal', label: 'Subtotal', amount: 1000, negative: false },
        { kind: 'tax', label: 'Tax', amount: 0, negative: false },
        { kind: 'total', label: 'Total', amount: 1000, negative: false },
      ],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockResolvedValue({ data: { version: FROZEN } });
});

describe('opening a past version', () => {
  it('renders the whole document as the customer received it', async () => {
    renderWithProviders(<EstimateVersionPage />);

    expect(await screen.findByText('Keypad')).toBeInTheDocument();
    expect(screen.getByText('Install 3 doors')).toBeInTheDocument();
    expect(screen.getByText('Business hours only.')).toBeInTheDocument();
    expect(screen.getByText('$800.00')).toBeInTheDocument();
    expect(screen.getAllByText('$1,000.00').length).toBeGreaterThan(0);
  });

  it("shows the version's photos", async () => {
    renderWithProviders(<EstimateVersionPage />);

    const img = await screen.findByAltText('Frame');
    expect(img).toHaveAttribute('src', 'https://signed.test/1.jpg');
  });

  it('says plainly that it is a past version and cannot be edited', async () => {
    renderWithProviders(<EstimateVersionPage />);

    expect(await screen.findByText(/Version 1 of E00042/)).toBeInTheDocument();
    expect(screen.getByText(/past version/i)).toHaveTextContent(/cannot be edited/i);
    expect(screen.getByText(/emailed to the customer/i)).toBeInTheDocument();
  });

  it('offers an obvious way back to the current estimate', async () => {
    renderWithProviders(<EstimateVersionPage />);

    const back = await screen.findByRole('link', { name: /current estimate/i });
    expect(back).toHaveAttribute('href', '/estimates/est-1');
  });

  it('offers no way to edit anything — the page has no controls at all', async () => {
    renderWithProviders(<EstimateVersionPage />);
    await screen.findByText('Keypad');

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });

  it('says so, with a way back, when the version cannot be opened', async () => {
    vi.mocked(api.get).mockRejectedValue({ response: { data: { error: 'Version not found' } } });

    renderWithProviders(<EstimateVersionPage />);

    expect(await screen.findByText('Version not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /current estimate/i })).toBeInTheDocument();
  });
});

/**
 * #2028 slice 3 — a version frozen BEFORE the slice still sections correctly.
 *
 * THIS IS WHY `documentSections()` IS DERIVED RATHER THAN STORED, and why the slice needed no
 * migration. `buildVersionSnapshotDocument` freezes the view-model as JSON: `scopeNotes`, `rows`,
 * `hasLineItems`, `hasScopes`, `totals` — and no `sections` key, because none existed when those
 * rows were written. The page hands that frozen object to `EstimateDocumentView` as `document`,
 * which runs `documentSections()` over it exactly as it does over a freshly built model.
 *
 * The fixtures below are therefore deliberately PRE-SLICE SHAPED: the legacy booleans are present
 * and `sections` is absent, so these fail the moment anyone stores the sections on the model and
 * reads them back, or rebuilds the document from props instead of honouring the frozen one.
 */
const PRE_SLICE_LINE = {
  kind: 'line_item', key: 'li-1', title: 'Keypad', detail: null, itemType: 'MATERIAL',
  quantity: 1, unitPrice: 200, grossAmount: null, netAmount: 200, discounted: false,
  discountType: null, discountValue: null, discountAmount: null, imageUrl: null, photos: [],
};

const PRE_SLICE_SCOPE = {
  kind: 'scope', key: 'scope-1', title: 'Install 3 doors', detail: 'Three of them.',
  itemType: null, quantity: null, unitPrice: null, grossAmount: null, netAmount: 800,
  discounted: false, discountType: null, discountValue: null, discountAmount: null,
  imageUrl: null, photos: [],
};

/** A version as the snapshot writer stored it before slice 3 existed. No `sections` key. */
function freezeVersion(rows: unknown[], scopeNotes: string | null, subtotal: number) {
  const view = {
    number: 'E00042',
    taxRate: 0,
    scopeNotes,
    // The legacy booleans the pre-slice model carried. Nothing reads them any more; they are here
    // because a real frozen row has them, and a fixture that quietly drops them would be testing
    // today's shape rather than the one actually sitting in the database.
    hasLineItems: rows.some((r) => (r as { kind: string }).kind === 'line_item'),
    hasScopes: rows.some((r) => (r as { kind: string }).kind === 'scope'),
    rows,
    totals: [
      { kind: 'subtotal', label: 'Subtotal', amount: subtotal, negative: false },
      { kind: 'tax', label: 'Tax', amount: 0, negative: false },
      { kind: 'total', label: 'Total', amount: subtotal, negative: false },
    ],
  };
  expect(view).not.toHaveProperty('sections');
  return { ...FROZEN, document: { customer: FROZEN.document.customer, view } };
}

describe('a version frozen before the document was split into sections', () => {
  // A frozen version sections through the SAME derived function as a live document, so Ran's
  // 2026-09-13 rule — a lone section is drawn with no heading over it — reaches past versions
  // too, and a version that printed "Scope of Work" yesterday prints the scope bare today. That
  // is the intent: the heading is part of the template, and the template is what is being fixed.
  // The frozen FIGURES are untouched, which is what the subtotal assertions here pin.
  it('draws only the scope content, under no heading, when that is all the frozen document has', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { version: freezeVersion([PRE_SLICE_SCOPE], null, 800) } });

    renderWithProviders(<EstimateVersionPage />);
    await screen.findByText('Install 3 doors');

    expect(sectionHeadings()).toEqual([]);
    expect(printedRowAmounts()).toEqual([800]);
    expect(printedTotal('Subtotal')).toBe(sumAmounts(printedRowAmounts()));
  });

  it('draws only the line items, under no heading, when that is all the frozen document has', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { version: freezeVersion([PRE_SLICE_LINE], null, 200) } });

    renderWithProviders(<EstimateVersionPage />);
    await screen.findByText('Keypad');

    expect(sectionHeadings()).toEqual([]);
    expect(printedRowAmounts()).toEqual([200]);
    expect(printedTotal('Subtotal')).toBe(sumAmounts(printedRowAmounts()));
  });

  it('draws both, scope of work first, with the frozen narrative inside the scope section', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: { version: freezeVersion([PRE_SLICE_LINE, PRE_SLICE_SCOPE], 'Business hours only.', 1000) },
    });

    renderWithProviders(<EstimateVersionPage />);
    await screen.findByText('Keypad');

    expect(sectionHeadings()).toEqual(['Scope of Work', 'Line Items']);
    // The narrative belongs to the scope section, not to a second card under the same heading.
    const scopeCard = document.querySelectorAll('h3')[0].parentElement!;
    expect(scopeCard.textContent).toContain('Business hours only.');
    expect(scopeCard.textContent).toContain('Install 3 doors');
    expect(scopeCard.textContent).not.toContain('Keypad');
    // The frozen rows are re-ordered into their sections, so the sum is still the frozen subtotal.
    expect(printedRowAmounts()).toEqual([800, 200]);
    expect(printedTotal('Subtotal')).toBe(1000);
  });

  it('draws no section headings at all, but still prints the totals, when the frozen document has neither', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { version: freezeVersion([], null, 0) } });

    renderWithProviders(<EstimateVersionPage />);
    await screen.findByText(/Version 1 of E00042/);

    // An empty document draws no header over nothing — but a version must still show what it was
    // sent for, so the totals card is unconditional.
    expect(sectionHeadings()).toEqual([]);
    expect(printedTotal('Subtotal')).toBe(0);
    expect(printedTotal('Total')).toBe(0);
  });
});
