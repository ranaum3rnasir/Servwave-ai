import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RangeSlider } from './RangeSlider';

describe('RangeSlider', () => {
  it('renders two range inputs', () => {
    render(<RangeSlider min={0} max={20} value={{ from: 0, to: 20 }} onChange={() => {}} />);
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(2);
    sliders.forEach((s) => expect(s).toHaveAttribute('type', 'range'));
  });

  it('clamps the min thumb to the current max when dragged past it', () => {
    const onChange = vi.fn();
    render(<RangeSlider min={0} max={20} value={{ from: 2, to: 10 }} onChange={onChange} />);
    const minInput = screen.getAllByRole('slider')[0]!;

    fireEvent.change(minInput, { target: { value: '15' } }); // drag min past the current max (10)

    expect(onChange).toHaveBeenCalledWith({ from: 10, to: 10 });
  });

  it('clamps the max thumb to the current min when dragged below it', () => {
    const onChange = vi.fn();
    render(<RangeSlider min={0} max={20} value={{ from: 5, to: 10 }} onChange={onChange} />);
    const maxInput = screen.getAllByRole('slider')[1]!;

    fireEvent.change(maxInput, { target: { value: '2' } }); // drag max below the current min (5)

    expect(onChange).toHaveBeenCalledWith({ from: 5, to: 5 });
  });

  it('fires onChange with the resulting {from, to} on a normal (non-clamping) drag', () => {
    const onChange = vi.fn();
    render(<RangeSlider min={0} max={20} value={{ from: 0, to: 15 }} onChange={onChange} />);
    const minInput = screen.getAllByRole('slider')[0]!;

    fireEvent.change(minInput, { target: { value: '4' } });

    expect(onChange).toHaveBeenCalledWith({ from: 4, to: 15 });
  });

  it('reports to: null once the max thumb reaches the domain ceiling (open-ended "N or more")', () => {
    const onChange = vi.fn();
    render(<RangeSlider min={0} max={20} value={{ from: 3, to: 15 }} onChange={onChange} />);
    const maxInput = screen.getAllByRole('slider')[1]!;

    fireEvent.change(maxInput, { target: { value: '20' } });

    expect(onChange).toHaveBeenCalledWith({ from: 3, to: null });
  });

  it('reports a concrete number again once the max thumb is dragged back below the ceiling', () => {
    const onChange = vi.fn();
    // value.to === null means "currently open-ended / at max" per the contract.
    render(<RangeSlider min={0} max={20} value={{ from: 3, to: null }} onChange={onChange} />);
    const maxInput = screen.getAllByRole('slider')[1]!;

    fireEvent.change(maxInput, { target: { value: '12' } });

    expect(onChange).toHaveBeenCalledWith({ from: 3, to: 12 });
  });

  it('does not crash on a zero-width domain (min === max)', () => {
    const onChange = vi.fn();
    render(<RangeSlider min={5} max={5} value={{ from: 5, to: 5 }} onChange={onChange} />);
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(2);
  });
});
