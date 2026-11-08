import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { LineItemsEditor, blankLineItem } from '@/components/crm/LineItemsEditor';

// Responsive line-item rows (#225): below lg the shared editor renders a labeled
// stacked mobile card; at >=lg it renders the dense 9-column desktop grid.
// The hide/show is JS-driven via useMediaQuery (window.matchMedia), NOT CSS
// `lg:hidden` dual-render — only ONE variant is ever mounted in the DOM, so
// placeholder/label queries always match exactly one node (see the vault
// learning css-hidden-cant-suppress-portals). jsdom drives the branch through
// the matchMedia mock: the global setup.ts mock returns matches:false (desktop);
// the mobile describe block overrides it to match the lg max-width query.

const mockApi = vi.mocked(api);

// Radix components need a constructable ResizeObserver in jsdom.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function mockMatchMedia(matchesFor: (query: string) => boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matchesFor(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function setupCommon() {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/price-book/categories') {
      return Promise.resolve({ data: { data: [] } });
    }
    return Promise.resolve({ data: { data: [] } });
  });
}

describe('LineItemsEditor — mobile stacked card (below lg)', () => {
  beforeEach(() => {
    setupCommon();
    // Override the global matches:false mock so the lg max-width query matches
    // (phone width) → isBelowLg true → ONLY the mobile variant mounts.
    mockMatchMedia((q) => q.includes('max-width: 1023.98px'));
  });

  it('renders exactly one labeled mobile card per row (no desktop header collision)', () => {
    renderWithProviders(
      <LineItemsEditor value={[blankLineItem()]} onChange={vi.fn()} />
    );

    // Each label resolves to exactly ONE node — unique because the desktop
    // header row (which also carries Qty/Price/Cost/Discount spans) is NOT
    // rendered when isBelowLg is true. Under a CSS lg:hidden dual-render these
    // singular queries would throw on multiple matches.
    expect(screen.getByText('Qty')).toBeInTheDocument();
    expect(screen.getByText('Price')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getByText('Discount')).toBeInTheDocument();
    expect(screen.getByText(/Taxable/i)).toBeInTheDocument();

    // Single-variant render: exactly one Name input, one Qty input.
    expect(screen.getByPlaceholderText('Item name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('1')).toBeInTheDocument();

    // The desktop 'Name' column header must be absent below lg.
    expect(screen.queryByText('Name')).not.toBeInTheDocument();
  });

  it('editing the mobile Qty field fires onChange with the digits-only sanitized quantity', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <LineItemsEditor value={[blankLineItem()]} onChange={onChange} />
    );

    const qtyInput = screen.getByPlaceholderText('1');
    fireEvent.change(qtyInput, { target: { value: '1.2x' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0][0].quantity).toBe(12);
  });

  it('Remove button carries the aria-label and is disabled at one row with minOneRow', () => {
    renderWithProviders(
      <LineItemsEditor value={[blankLineItem()]} onChange={vi.fn()} />
    );

    const removeBtn = screen.getByRole('button', { name: /Remove/ });
    expect(removeBtn).toBeDisabled();
  });
});

describe('LineItemsEditor — desktop dense grid (>=lg)', () => {
  beforeEach(() => {
    setupCommon();
    // Global setup.ts default: matchMedia matches:false → isBelowLg false →
    // ONLY the desktop variant mounts (same branch every existing form test
    // exercises). Re-set explicitly since the mobile block replaced the mock.
    mockMatchMedia(() => false);
  });

  it('renders exactly one desktop row with the column-header labels', () => {
    renderWithProviders(
      <LineItemsEditor value={[blankLineItem()]} onChange={vi.fn()} />
    );

    // Singular queries prove the mobile card is NOT mounted alongside.
    expect(screen.getByPlaceholderText('Item name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('1')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Qty')).toBeInTheDocument();

    // The mobile-only 'Taxable' text label must be absent at desktop.
    expect(screen.queryByText(/Taxable/i)).not.toBeInTheDocument();
  });
});
