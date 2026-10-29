/**
 * The shared CRM line-items editor's per-row profitability (PRD #2186, slice 09).
 *
 * The row used to compute its own margin from `Number(item.unit_cost)` — and
 * `Number(null)` is 0, so a row nobody had costed was read as costing nothing
 * and advertised 100% margin. It now reads the shared calculator, shows margin
 * and markup side by side under their full words, and renders an em dash where
 * there is no figure. Both responsive variants carry the same pair.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { LineItemsEditor, blankLineItem, type LineItem } from '@/components/crm/LineItemsEditor';

const mockApi = vi.mocked(api);

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
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  mockApi.get.mockResolvedValue({ data: { data: [] } });
}

function row(overrides: Partial<LineItem>): LineItem {
  return { ...blankLineItem(), name: 'Compressor swap', quantity: 1, unit_price: 150, ...overrides };
}

function figureUnder(word: string) {
  const pair = screen.getByRole('group', { name: /profitability for compressor swap/i });
  return within(pair).getByText(word).parentElement?.querySelector('dd')?.textContent ?? '';
}

describe.each([
  ['desktop grid', (q: string) => !q.includes('max-width: 1023.98px')],
  ['mobile stacked card', (q: string) => q.includes('max-width: 1023.98px')],
])('LineItemsEditor — %s margin and markup', (_label, matcher) => {
  beforeEach(() => {
    setupCommon();
    mockMatchMedia(matcher);
  });

  it('shows margin and markup side by side under their full words', () => {
    renderWithProviders(
      <LineItemsEditor value={[row({ unit_cost: 90 })]} onChange={vi.fn()} />,
    );

    // margin (150-90)/150 = 40%; markup (150-90)/90 = 67%.
    expect(figureUnder('Margin')).toBe('40%');
    expect(figureUnder('Markup')).toBe('67%');
  });

  it('shows an em dash, never 100%, for a row nobody costed', () => {
    renderWithProviders(
      <LineItemsEditor value={[row({ unit_cost: null })]} onChange={vi.fn()} />,
    );

    expect(figureUnder('Margin')).toBe('—');
    expect(figureUnder('Markup')).toBe('—');
    const pair = screen.getByRole('group', { name: /profitability for compressor swap/i });
    expect(within(pair).queryByText('100%')).not.toBeInTheDocument();
  });
});
