/**
 * PaletteSwatchPicker's two optional additions for Settings > Lists (V7-04b): colour names and the large swatch. Callers
 * that pass neither (the tag input, the category form) must be exactly as before.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaletteSwatchPicker } from '@/components/form/PaletteSwatchPicker';
import { DEFAULT_TAG_COLOR, TAG_COLORS, TAG_COLOR_NAMES, tagColorName } from '@/lib/tag-colors';

describe('tag colour names', () => {
  it('name each of the ten palette colours in order, and the default is Grey', () => {
    expect(TAG_COLOR_NAMES).toHaveLength(TAG_COLORS.length);
    expect(TAG_COLOR_NAMES).toEqual(['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Violet', 'Pink', 'Grey', 'Teal']);
    expect(tagColorName(TAG_COLORS[3]!)).toBe('Green');
    expect(tagColorName(TAG_COLORS[3]!.toLowerCase())).toBe('Green');
    expect(tagColorName(DEFAULT_TAG_COLOR)).toBe('Grey');
  });

  it('say the stored value for a colour off the palette', () => {
    const odd = ['#', '123456'].join('');
    expect(tagColorName(odd)).toBe(odd);
  });
});

describe('PaletteSwatchPicker', () => {
  it('without names keeps the "Color #HEX" labels and no title (existing callers unchanged)', () => {
    render(<PaletteSwatchPicker colors={TAG_COLORS} value={TAG_COLORS[0]!} onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: `Color ${TAG_COLORS[0]}` })).toBeChecked();
    expect(screen.getByRole('radio', { name: `Color ${TAG_COLORS[0]}` })).not.toHaveAttribute('title');
  });

  it('with names labels and titles each swatch with its colour name', () => {
    render(<PaletteSwatchPicker colors={TAG_COLORS} names={TAG_COLOR_NAMES} value={TAG_COLORS[6]!} onChange={() => {}} />);
    const violet = screen.getByRole('radio', { name: 'Violet' });
    expect(violet).toBeChecked();
    expect(violet).toHaveAttribute('title', 'Violet');
    expect(screen.queryByRole('radio', { name: /^Color / })).not.toBeInTheDocument();
  });

  it('the large swatch is a 32px target (44px on a phone) with a check on the selected colour only', async () => {
    const onChange = vi.fn();
    const { container } = render(<PaletteSwatchPicker size="large" colors={TAG_COLORS} names={TAG_COLOR_NAMES} value={TAG_COLORS[3]!} onChange={onChange} />);
    const green = screen.getByRole('radio', { name: 'Green' });
    expect(green.className).toContain('h-11 w-11');
    expect(green.className).toContain('min-[641px]:h-8');
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(green.querySelector('svg')).not.toBeNull();
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Blue' }));
    expect(onChange).toHaveBeenCalledWith(TAG_COLORS[5]);
  });
});
