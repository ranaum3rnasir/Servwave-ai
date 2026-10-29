import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppliedChips } from './AppliedChips';
import type { FacetConfig, FilterState } from '@/lib/filters/types';
import { formatCurrency } from '@/lib/utils';

const statusFacet: FacetConfig = {
  key: 'status',
  label: 'Status',
  icon: 'M0 0',
  kind: 'multi',
  options: [
    { value: 'new', label: 'New' },
    { value: 'won', label: 'Won' },
    { value: 'lost', label: 'Lost' },
    { value: 'contacted', label: 'Contacted' },
  ],
  param: 'status',
};

const sourceFacet: FacetConfig = {
  key: 'source',
  label: 'Source',
  icon: 'M0 0',
  kind: 'multi',
  optionSource: 'sources', // no static options — labels aren't resolvable here
  param: 'source',
};

const estimatesFacet: FacetConfig = {
  key: 'estimates',
  label: '# of Estimates',
  icon: 'M0 0',
  kind: 'range',
  unit: 'estimates',
  maxSource: 'estimatesMax',
  param: 'estimates',
};

const revenueFacet: FacetConfig = {
  key: 'revenue',
  label: 'Revenue',
  icon: 'M0 0',
  kind: 'range',
  money: true,
  maxSource: 'revenueMax',
  param: 'revenue',
};

const createdFacet: FacetConfig = {
  key: 'created',
  label: 'Created',
  icon: 'M0 0',
  kind: 'dateRange',
  param: 'created',
};

const registry: FacetConfig[] = [statusFacet, sourceFacet, estimatesFacet, revenueFacet, createdFacet];

describe('AppliedChips', () => {
  it('renders nothing when every facet value is empty/absent', () => {
    const { container } = render(<AppliedChips registry={registry} value={{}} onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one chip per selected multi value, using the facet label + option label', () => {
    const value: FilterState = { status: { kind: 'multi', values: ['new', 'won'] } };
    render(<AppliedChips registry={registry} value={value} onChange={() => {}} />);
    expect(screen.getByText('Status: New')).toBeInTheDocument();
    expect(screen.getByText('Status: Won')).toBeInTheDocument();
  });

  it('falls back to the raw stored value when the facet has no static options and no resolveOptions is provided', () => {
    const value: FilterState = { source: { kind: 'multi', values: ['google'] } };
    render(<AppliedChips registry={registry} value={value} onChange={() => {}} />);
    expect(screen.getByText('Source: google')).toBeInTheDocument();
  });

  it('resolves a dynamic-optionSource facet\'s value to its label via the resolveOptions prop', () => {
    const value: FilterState = { source: { kind: 'multi', values: ['u1'] } };
    const resolveOptions = (sourceId: string) =>
      sourceId === 'sources' ? [{ value: 'u1', label: 'Alex Romero' }] : [];
    render(
      <AppliedChips registry={registry} value={value} onChange={() => {}} resolveOptions={resolveOptions} />
    );
    expect(screen.getByText('Source: Alex Romero')).toBeInTheDocument();
  });

  it('resolves the UNASSIGNED sentinel to its "Unassigned" label via resolveOptions, not the raw sentinel', () => {
    const value: FilterState = { source: { kind: 'multi', values: ['UNASSIGNED'] } };
    const resolveOptions = (sourceId: string) =>
      sourceId === 'sources' ? [{ value: 'UNASSIGNED', label: 'Unassigned' }, { value: 'u1', label: 'Alex Romero' }] : [];
    render(
      <AppliedChips registry={registry} value={value} onChange={() => {}} resolveOptions={resolveOptions} />
    );
    expect(screen.getByText('Source: Unassigned')).toBeInTheDocument();
    expect(screen.queryByText('Source: UNASSIGNED')).toBeNull();
  });

  it('falls back to the raw value (and does not crash) when resolveOptions has no matching option for it', () => {
    const value: FilterState = { source: { kind: 'multi', values: ['ghost-id'] } };
    const resolveOptions = (sourceId: string) =>
      sourceId === 'sources' ? [{ value: 'u1', label: 'Alex Romero' }] : [];
    render(
      <AppliedChips registry={registry} value={value} onChange={() => {}} resolveOptions={resolveOptions} />
    );
    expect(screen.getByText('Source: ghost-id')).toBeInTheDocument();
  });

  it('collapses a multi facet with many selected values into N individual chips + a "+N more" chip', () => {
    const value: FilterState = {
      status: { kind: 'multi', values: ['new', 'won', 'lost', 'contacted'] },
    };
    render(<AppliedChips registry={registry} value={value} onChange={() => {}} />);
    expect(screen.getByText('Status: New')).toBeInTheDocument();
    expect(screen.getByText('Status: Won')).toBeInTheDocument();
    expect(screen.getByText('Status: Lost')).toBeInTheDocument();
    expect(screen.queryByText('Status: Contacted')).toBeNull();
    expect(screen.getByText('+1 more')).toBeInTheDocument();
  });

  it('removing an individual multi-value chip removes only that value, leaving the rest and other facets untouched', async () => {
    const onChange = vi.fn();
    const value: FilterState = {
      status: { kind: 'multi', values: ['new', 'won'] },
      created: { kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' },
    };
    render(<AppliedChips registry={registry} value={value} onChange={onChange} />);
    const chip = screen.getByText('Status: New').closest('div') as HTMLElement;
    await userEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({
      status: { kind: 'multi', values: ['won'] },
      created: { kind: 'dateRange', from: '2026-01-01', to: '2026-01-31' },
    });
  });

  it('removing the "+N more" chip clears the entire facet', async () => {
    const onChange = vi.fn();
    const value: FilterState = {
      status: { kind: 'multi', values: ['new', 'won', 'lost', 'contacted'] },
    };
    render(<AppliedChips registry={registry} value={value} onChange={onChange} />);
    const moreChip = screen.getByText('+1 more').closest('div') as HTMLElement;
    await userEvent.click(moreChip);
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('renders a closed range as "from-to"', () => {
    const value: FilterState = { estimates: { kind: 'range', from: 3, to: 8 } };
    render(<AppliedChips registry={registry} value={value} onChange={() => {}} />);
    expect(screen.getByText('# of Estimates: 3-8')).toBeInTheDocument();
  });

  it('renders an open-ended-upper range (to: null) as "from+"', () => {
    const value: FilterState = { estimates: { kind: 'range', from: 3, to: null } };
    render(<AppliedChips registry={registry} value={value} onChange={() => {}} />);
    expect(screen.getByText('# of Estimates: 3+')).toBeInTheDocument();
  });

  it('renders an open-ended-lower range (from: null, reachable via a bookmarked URL) as "up to <to>"', () => {
    const value: FilterState = { estimates: { kind: 'range', from: null, to: 8 } };
    render(<AppliedChips registry={registry} value={value} onChange={() => {}} />);
    expect(screen.getByText('# of Estimates: up to 8')).toBeInTheDocument();
  });

  it('money-formats range bounds when facet.money is set', () => {
    const value: FilterState = { revenue: { kind: 'range', from: 1000, to: 5000 } };
    render(<AppliedChips registry={registry} value={value} onChange={() => {}} />);
    expect(
      screen.getByText(`Revenue: ${formatCurrency(1000)}-${formatCurrency(5000)}`)
    ).toBeInTheDocument();
  });

  it('removing a range chip clears just that facet\'s key, leaving other facets untouched', async () => {
    const onChange = vi.fn();
    const value: FilterState = {
      estimates: { kind: 'range', from: 3, to: 8 },
      status: { kind: 'multi', values: ['new'] },
    };
    render(<AppliedChips registry={registry} value={value} onChange={onChange} />);
    const chip = screen.getByText('# of Estimates: 3-8').closest('div') as HTMLElement;
    await userEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({ status: { kind: 'multi', values: ['new'] } });
  });

  it('renders a formatted dateRange chip using the existing formatDayLabel-based text', () => {
    const value: FilterState = { created: { kind: 'dateRange', from: '2026-01-01', to: '2026-02-01' } };
    render(<AppliedChips registry={registry} value={value} onChange={() => {}} />);
    expect(screen.getByText('Created: Jan 1, 2026 – Feb 1, 2026')).toBeInTheDocument();
  });

  it('removing a dateRange chip clears just that facet\'s key', async () => {
    const onChange = vi.fn();
    const value: FilterState = { created: { kind: 'dateRange', from: '2026-01-01', to: '2026-02-01' } };
    render(<AppliedChips registry={registry} value={value} onChange={onChange} />);
    const chip = screen.getByText('Created: Jan 1, 2026 – Feb 1, 2026').closest('div') as HTMLElement;
    await userEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('skips a facet whose value is present but empty (multi: values: [])', () => {
    const value: FilterState = { status: { kind: 'multi', values: [] } };
    const { container } = render(<AppliedChips registry={registry} value={value} onChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
