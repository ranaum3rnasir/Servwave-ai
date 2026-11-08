import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CheckboxFacet } from './CheckboxFacet';
import type { FacetConfig, FacetOption, FilterValue } from '@/lib/filters/types';

const facet: FacetConfig = {
  key: 'status',
  label: 'Status',
  icon: 'M0 0',
  kind: 'multi',
  param: 'status',
};

const fewOptions: FacetOption[] = [
  { value: 'open', label: 'Open' },
  { value: 'closed', label: 'Closed' },
  { value: 'pending', label: 'Pending' },
];

const manyOptions: FacetOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
  { value: 'd', label: 'Delta' },
  { value: 'e', label: 'Echo' },
  { value: 'f', label: 'Foxtrot' },
  { value: 'g', label: 'Golf' },
];

describe('CheckboxFacet', () => {
  it('does not render a search box when there are 6 or fewer options', () => {
    render(<CheckboxFacet facet={facet} value={undefined} onChange={() => {}} options={fewOptions} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('renders a search box when there are more than 6 options', () => {
    render(<CheckboxFacet facet={facet} value={undefined} onChange={() => {}} options={manyOptions} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('filters the option list live, case-insensitively, as the user types', async () => {
    render(<CheckboxFacet facet={facet} value={undefined} onChange={() => {}} options={manyOptions} />);
    const search = screen.getByRole('textbox');
    await userEvent.type(search, 'cha');
    expect(screen.getByText('Charlie')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.queryByText('Bravo')).toBeNull();
  });

  it('renders every option (unfiltered) when the search box is empty', () => {
    render(<CheckboxFacet facet={facet} value={undefined} onChange={() => {}} options={manyOptions} />);
    manyOptions.forEach((o) => expect(screen.getByText(o.label)).toBeInTheDocument());
  });

  it('initializes a fresh multi value when toggling a checkbox with value undefined', async () => {
    const onChange = vi.fn();
    render(<CheckboxFacet facet={facet} value={undefined} onChange={onChange} options={fewOptions} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Open' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'multi', values: ['open'] });
  });

  it('adds a value to the existing selection', async () => {
    const onChange = vi.fn();
    const value: FilterValue = { kind: 'multi', values: ['closed'] };
    render(<CheckboxFacet facet={facet} value={value} onChange={onChange} options={fewOptions} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Open' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'multi', values: ['closed', 'open'] });
  });

  it('removes a value when unchecking an already-selected option', async () => {
    const onChange = vi.fn();
    const value: FilterValue = { kind: 'multi', values: ['open', 'closed'] };
    render(<CheckboxFacet facet={facet} value={value} onChange={onChange} options={fewOptions} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Open' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'multi', values: ['closed'] });
  });

  it('renders a swatch dot when an option has one', () => {
    const swatchOptions: FacetOption[] = [{ value: 'open', label: 'Open', swatch: '#2F7D5D' }];
    render(<CheckboxFacet facet={facet} value={undefined} onChange={() => {}} options={swatchOptions} />);
    const row = screen.getByText('Open').closest('label') as HTMLElement;
    const swatch = row.querySelector('[style*="background-color"]');
    expect(swatch).not.toBeNull();
  });

  it('does not render a swatch dot when an option has none', () => {
    render(<CheckboxFacet facet={facet} value={undefined} onChange={() => {}} options={fewOptions} />);
    const row = screen.getByText('Open').closest('label') as HTMLElement;
    expect(row.querySelector('[style*="background-color"]')).toBeNull();
  });

  it('hides the Clear control when nothing is selected', () => {
    render(<CheckboxFacet facet={facet} value={undefined} onChange={() => {}} options={fewOptions} />);
    expect(screen.queryByRole('button', { name: /clear status/i })).toBeNull();
  });

  it('hides the Clear control when value.values is an empty array', () => {
    render(
      <CheckboxFacet
        facet={facet}
        value={{ kind: 'multi', values: [] }}
        onChange={() => {}}
        options={fewOptions}
      />
    );
    expect(screen.queryByRole('button', { name: /clear status/i })).toBeNull();
  });

  it('shows the Clear control once at least one value is selected, and clearing empties only its own facet', async () => {
    const onChangeA = vi.fn();
    const onChangeB = vi.fn();
    const facetB: FacetConfig = { ...facet, key: 'priority', label: 'Priority', param: 'priority' };
    const valueA: FilterValue = { kind: 'multi', values: ['open'] };

    render(
      <>
        <CheckboxFacet facet={facet} value={valueA} onChange={onChangeA} options={fewOptions} />
        <CheckboxFacet facet={facetB} value={undefined} onChange={onChangeB} options={fewOptions} />
      </>
    );

    const clearButton = screen.getByRole('button', { name: /clear status/i });
    await userEvent.click(clearButton);

    expect(onChangeA).toHaveBeenCalledTimes(1);
    expect(onChangeA).toHaveBeenCalledWith({ kind: 'multi', values: [] });
    expect(onChangeB).not.toHaveBeenCalled();
  });

  it('falls back to facet.options when no options prop is passed', () => {
    render(<CheckboxFacet facet={{ ...facet, options: fewOptions }} value={undefined} onChange={() => {}} />);
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  describe('Select all / Deselect all', () => {
    it('shows "Select all" when no options are selected', () => {
      render(<CheckboxFacet facet={facet} value={undefined} onChange={() => {}} options={fewOptions} />);
      expect(screen.getByRole('button', { name: /select all/i })).toBeInTheDocument();
    });

    it('shows "Select all" when some (but not all) visible options are selected', () => {
      const value: FilterValue = { kind: 'multi', values: ['open'] };
      render(<CheckboxFacet facet={facet} value={value} onChange={() => {}} options={fewOptions} />);
      expect(screen.getByRole('button', { name: /select all/i })).toBeInTheDocument();
    });

    it('selects every visible option when "Select all" is clicked with none selected', async () => {
      const onChange = vi.fn();
      render(<CheckboxFacet facet={facet} value={undefined} onChange={onChange} options={fewOptions} />);
      await userEvent.click(screen.getByRole('button', { name: /select all/i }));
      expect(onChange).toHaveBeenCalledWith({ kind: 'multi', values: ['open', 'closed', 'pending'] });
    });

    it('selects the remaining visible options when "Select all" is clicked with some already selected', async () => {
      const onChange = vi.fn();
      const value: FilterValue = { kind: 'multi', values: ['open'] };
      render(<CheckboxFacet facet={facet} value={value} onChange={onChange} options={fewOptions} />);
      await userEvent.click(screen.getByRole('button', { name: /select all/i }));
      expect(onChange).toHaveBeenCalledWith({ kind: 'multi', values: ['open', 'closed', 'pending'] });
    });

    it('shows "Deselect all" once every visible option is selected', () => {
      const value: FilterValue = { kind: 'multi', values: ['open', 'closed', 'pending'] };
      render(<CheckboxFacet facet={facet} value={value} onChange={() => {}} options={fewOptions} />);
      expect(screen.getByRole('button', { name: /deselect all/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^select all$/i })).toBeNull();
    });

    it('removes every visible option when "Deselect all" is clicked', async () => {
      const onChange = vi.fn();
      const value: FilterValue = { kind: 'multi', values: ['open', 'closed', 'pending'] };
      render(<CheckboxFacet facet={facet} value={value} onChange={onChange} options={fewOptions} />);
      await userEvent.click(screen.getByRole('button', { name: /deselect all/i }));
      expect(onChange).toHaveBeenCalledWith({ kind: 'multi', values: [] });
    });

    it('preserves a selection hidden by an active search filter when "Select all" is clicked', async () => {
      const onChange = vi.fn();
      // 'b' (Bravo) is pre-selected but the search below will filter it out of view.
      const value: FilterValue = { kind: 'multi', values: ['b'] };
      render(<CheckboxFacet facet={facet} value={value} onChange={onChange} options={manyOptions} />);

      const search = screen.getByRole('textbox');
      await userEvent.type(search, 'cha'); // narrows visible options to just "Charlie"
      expect(screen.getByText('Charlie')).toBeInTheDocument();
      expect(screen.queryByText('Bravo')).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: /select all/i }));
      // Only the currently-visible option ('c') is added; the hidden pre-existing
      // selection ('b') must survive untouched.
      expect(onChange).toHaveBeenCalledWith({ kind: 'multi', values: ['b', 'c'] });
    });

    it('preserves a selection hidden by an active search filter when "Deselect all" is clicked', async () => {
      const onChange = vi.fn();
      // 'b' (Bravo) is selected and hidden by the search; 'c' (Charlie) is
      // selected and visible. Deselect all should remove only 'c'.
      const value: FilterValue = { kind: 'multi', values: ['b', 'c'] };
      render(<CheckboxFacet facet={facet} value={value} onChange={onChange} options={manyOptions} />);

      const search = screen.getByRole('textbox');
      await userEvent.type(search, 'cha');
      expect(screen.getByText('Charlie')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /deselect all/i }));
      expect(onChange).toHaveBeenCalledWith({ kind: 'multi', values: ['b'] });
    });
  });
});
