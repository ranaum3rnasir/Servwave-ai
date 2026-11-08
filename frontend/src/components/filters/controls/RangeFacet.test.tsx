import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RangeFacet } from './RangeFacet';
import type { FacetConfig, FilterValue } from '@/lib/filters/types';
import { formatCurrency } from '@/lib/utils';

const facet: FacetConfig = {
  key: 'estimateCount',
  label: '# of Estimates',
  icon: 'M0 0',
  kind: 'range',
  unit: 'estimates',
  param: 'estimates',
};

describe('RangeFacet', () => {
  it('renders the RangeSlider with a 0-based domain floor by default', () => {
    render(<RangeFacet facet={facet} value={undefined} onChange={() => {}} max={50} />);
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(2);
    expect(sliders[0]).toHaveAttribute('min', '0');
    expect(sliders[0]).toHaveAttribute('max', '50');
  });

  it('uses facet.min as the domain floor when provided', () => {
    render(<RangeFacet facet={{ ...facet, min: 5 }} value={undefined} onChange={() => {}} max={50} />);
    const sliders = screen.getAllByRole('slider');
    expect(sliders[0]).toHaveAttribute('min', '5');
  });

  it('renders two number inputs for typed From/To entry', () => {
    render(<RangeFacet facet={facet} value={{ kind: 'range', from: 2, to: 10 }} onChange={() => {}} max={50} />);
    expect(screen.getByLabelText(/from/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/to/i)).toBeInTheDocument();
  });

  it('produces {to: null} (open-ended) when the To field is cleared', () => {
    const onChange = vi.fn();
    const value: FilterValue = { kind: 'range', from: 2, to: 10 };
    render(<RangeFacet facet={facet} value={value} onChange={onChange} max={50} />);
    const toInput = screen.getByLabelText(/to/i);
    fireEvent.change(toInput, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'range', from: 2, to: null });
  });

  it('produces {to: null} when the slider max thumb is dragged to the domain ceiling', () => {
    const onChange = vi.fn();
    const value: FilterValue = { kind: 'range', from: 2, to: 10 };
    render(<RangeFacet facet={facet} value={value} onChange={onChange} max={50} />);
    const maxThumb = screen.getAllByRole('slider')[1]!;
    fireEvent.change(maxThumb, { target: { value: '50' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'range', from: 2, to: null });
  });

  it('updates from/to via the typed number inputs (non-money facet, raw numbers)', () => {
    const onChange = vi.fn();
    render(<RangeFacet facet={facet} value={{ kind: 'range', from: 0, to: 10 }} onChange={onChange} max={50} />);
    const fromInput = screen.getByLabelText(/from/i);
    fireEvent.change(fromInput, { target: { value: '4' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'range', from: 4, to: 10 });
  });

  it('stores a raw number (never a formatted string) in state for a money facet', () => {
    const onChange = vi.fn();
    const moneyFacet: FacetConfig = { ...facet, money: true, param: 'revenue', label: 'Revenue' };
    render(
      <RangeFacet
        facet={moneyFacet}
        value={{ kind: 'range', from: 0, to: 5000 }}
        onChange={onChange}
        max={5000}
      />
    );
    const fromInput = screen.getByLabelText(/from/i);
    fireEvent.change(fromInput, { target: { value: '1234' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'range', from: 1234, to: 5000 });
  });

  it('displays the From/To fields formatted via formatCurrency when unfocused and facet.money is true', () => {
    const moneyFacet: FacetConfig = { ...facet, money: true, param: 'revenue', label: 'Revenue' };
    render(
      <RangeFacet
        facet={moneyFacet}
        value={{ kind: 'range', from: 1234, to: 5000 }}
        onChange={() => {}}
        max={10000}
      />
    );
    expect(screen.getByDisplayValue(formatCurrency(1234))).toBeInTheDocument();
  });

  it('shows the raw editable number once the money field is focused', async () => {
    const moneyFacet: FacetConfig = { ...facet, money: true, param: 'revenue', label: 'Revenue' };
    render(
      <RangeFacet
        facet={moneyFacet}
        value={{ kind: 'range', from: 1234, to: 5000 }}
        onChange={() => {}}
        max={10000}
      />
    );
    const fromInput = screen.getByLabelText(/from/i);
    await userEvent.click(fromInput);
    expect((fromInput as HTMLInputElement).value).toBe('1234');
  });

  it('re-formats back to currency display after blur', async () => {
    const moneyFacet: FacetConfig = { ...facet, money: true, param: 'revenue', label: 'Revenue' };
    render(
      <RangeFacet
        facet={moneyFacet}
        value={{ kind: 'range', from: 1234, to: 5000 }}
        onChange={() => {}}
        max={10000}
      />
    );
    const fromInput = screen.getByLabelText(/from/i);
    await userEvent.click(fromInput);
    fireEvent.blur(fromInput);
    expect(screen.getByDisplayValue(formatCurrency(1234))).toBeInTheDocument();
  });

  it('does not money-format a non-money facet', () => {
    render(<RangeFacet facet={facet} value={{ kind: 'range', from: 1234, to: 5000 }} onChange={() => {}} max={10000} />);
    expect(screen.getByLabelText(/from/i)).toHaveValue(1234);
  });
});
