import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { FilterBar } from './FilterBar';
import type { FacetConfig, FacetOption, FilterState } from '@/lib/filters/types';

// Radix Popover needs a real constructable ResizeObserver + fireEvent (not
// userEvent) to open in jsdom — see src/__tests__/filter-popover-viewport.test.tsx
// for the established precedent this mirrors.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const registry: FacetConfig[] = [
  {
    key: 'status',
    label: 'Status',
    icon: 'M0 0',
    kind: 'multi',
    options: [
      { value: 'new', label: 'New' },
      { value: 'won', label: 'Won' },
    ],
    param: 'status',
  },
  {
    key: 'source',
    label: 'Source',
    icon: 'M0 0',
    kind: 'multi',
    optionSource: 'sources',
    param: 'source',
  },
  {
    key: 'estimates',
    label: '# of Estimates',
    icon: 'M0 0',
    kind: 'range',
    unit: 'estimates',
    maxSource: 'estimatesMax',
    param: 'estimates',
  },
  {
    key: 'created',
    label: 'Created',
    icon: 'M0 0',
    kind: 'dateRange',
    param: 'created',
  },
];

const sourceOptions: FacetOption[] = [
  { value: 'google', label: 'Google' },
  { value: 'referral', label: 'Referral' },
];

function setup(value: FilterState = {}, onChange = vi.fn()) {
  const resolveOptions = vi.fn((sourceId: string) => (sourceId === 'sources' ? sourceOptions : []));
  const resolveMax = vi.fn((sourceId: string) => (sourceId === 'estimatesMax' ? 25 : 0));
  // #1634: the dateRange facet's control (DateFacet) now calls
  // useScheduleTimezone(), which needs a QueryClientProvider ancestor.
  renderWithProviders(
    <FilterBar
      registry={registry}
      value={value}
      onChange={onChange}
      resolveOptions={resolveOptions}
      resolveMax={resolveMax}
    />
  );
  return { onChange, resolveOptions, resolveMax };
}

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: /filter/i }));
}

describe('FilterBar', () => {
  it('renders one rail row per registered facet, in registry order', () => {
    setup();
    openPopover();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      expect.stringContaining('Status'),
      expect.stringContaining('Source'),
      expect.stringContaining('# of Estimates'),
      expect.stringContaining('Created'),
    ]);
  });

  it('selects the first facet by default and renders its control in the right pane', () => {
    setup();
    openPopover();
    expect(screen.getByRole('tab', { name: /status/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
  });

  it('clicking a rail row selects it and swaps the right pane to a range control', () => {
    setup();
    openPopover();
    fireEvent.click(screen.getByRole('tab', { name: /estimates/i }));
    expect(screen.getByRole('tab', { name: /estimates/i })).toHaveAttribute('aria-selected', 'true');
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(2);
  });

  it('clicking a rail row selects it and swaps the right pane to a dateRange control', () => {
    setup();
    openPopover();
    fireEvent.click(screen.getByRole('tab', { name: /created/i }));
    expect(screen.getByRole('tab', { name: /created/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('combobox')).toHaveTextContent('Any time');
  });

  it('renders a static-options multi facet without calling resolveOptions', () => {
    const { resolveOptions } = setup();
    openPopover();
    // Status is selected by default and uses facet.options directly.
    expect(resolveOptions).not.toHaveBeenCalled();
  });

  it('resolves a dynamic optionSource multi facet via resolveOptions and renders its options', () => {
    const { resolveOptions } = setup();
    openPopover();
    fireEvent.click(screen.getByRole('tab', { name: /source/i }));
    expect(resolveOptions).toHaveBeenCalledWith('sources');
    expect(screen.getByText('Google')).toBeInTheDocument();
    expect(screen.getByText('Referral')).toBeInTheDocument();
  });

  it('resolves a range facet\'s maxSource via resolveMax and passes it through as RangeFacet\'s max', () => {
    const { resolveMax } = setup();
    openPopover();
    fireEvent.click(screen.getByRole('tab', { name: /estimates/i }));
    expect(resolveMax).toHaveBeenCalledWith('estimatesMax');
    const sliders = screen.getAllByRole('slider');
    expect(sliders[0]).toHaveAttribute('max', '25');
  });

  it('shows an active-count badge on a rail row only once that facet has a value, and hides it otherwise', () => {
    setup({ status: { kind: 'multi', values: ['new', 'won'] } });
    openPopover();
    const statusTab = screen.getByRole('tab', { name: /status/i });
    expect(within(statusTab).getByText('2')).toBeInTheDocument();
    const sourceTab = screen.getByRole('tab', { name: /source/i });
    expect(within(sourceTab).queryByText(/^\d+$/)).toBeNull();
  });

  it("a control's onChange updates only its own facet's slot, leaving other facets' committed values untouched", async () => {
    const initialValue: FilterState = { created: { kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' } };
    const { onChange } = setup(initialValue);
    openPopover();
    // Status is selected by default; check "New".
    await userEvent.click(screen.getByRole('checkbox', { name: 'New' }));
    expect(onChange).toHaveBeenCalledWith({
      created: { kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' },
      status: { kind: 'multi', values: ['new'] },
    });
  });

  it('switching rail rows away and back preserves the previously committed facet value', () => {
    setup({ status: { kind: 'multi', values: ['new'] } });
    openPopover();
    expect(screen.getByRole('checkbox', { name: 'New' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('tab', { name: /created/i }));
    expect(screen.queryByText('New')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /status/i }));
    expect(screen.getByRole('checkbox', { name: 'New' })).toHaveAttribute('aria-checked', 'true');
  });

  it('global "Clear all" empties every facet in one onChange({}) call', () => {
    const initialValue: FilterState = {
      status: { kind: 'multi', values: ['new'] },
      estimates: { kind: 'range', from: 1, to: 10 },
    };
    const { onChange } = setup(initialValue);
    openPopover();
    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('hides "Clear all" when nothing is selected', () => {
    setup();
    openPopover();
    expect(screen.queryByRole('button', { name: /clear all/i })).toBeNull();
  });

  it('footer reads "N selected across M filters"', () => {
    const initialValue: FilterState = {
      status: { kind: 'multi', values: ['new', 'won'] },
      estimates: { kind: 'range', from: 1, to: 10 },
    };
    setup(initialValue);
    openPopover();
    expect(screen.getByText('3 selected across 2 filters')).toBeInTheDocument();
  });

  it('footer reads "0 selected across 0 filters" and the trigger badge is hidden when nothing is selected', () => {
    setup();
    openPopover();
    expect(screen.getByText('0 selected across 0 filters')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter/i }).textContent).not.toMatch(/\d/);
  });

  it('trigger badge shows the total selected count, consistent with the footer', () => {
    const initialValue: FilterState = { status: { kind: 'multi', values: ['new', 'won'] } };
    setup(initialValue);
    const trigger = screen.getByRole('button', { name: /filter/i });
    expect(within(trigger).getByText('2')).toBeInTheDocument();
  });

  it('"Done" closes the popover', () => {
    setup();
    openPopover();
    expect(screen.getByText('Filters')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    expect(screen.queryByText('Filters')).toBeNull();
  });
});
