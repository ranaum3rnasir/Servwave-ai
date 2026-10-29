import { cn } from '@/lib/utils';

interface PaletteSwatchPickerProps {
  /** The palette, in display order - persisted `#RRGGBB` values, not theme tokens. */
  colors: readonly string[];
  value: string;
  onChange: (color: string) => void;
  /** Accessible name of the group. Defaults to "Color". */
  'aria-label'?: string;
}

/**
 * Pick one color from a fixed palette: a row of round swatches with radio semantics (one group,
 * one checked), so a screen reader hears "Color #22C55E, radio, checked, 4 of 10".
 *
 * The swatch is painted with an inline style for the same reason the tag chips are: the color is
 * stored data, not a theme token. Matching is case-insensitive, so a stored lower-case hex still
 * shows as selected.
 */
export function PaletteSwatchPicker({ colors, value, onChange, 'aria-label': ariaLabel = 'Color' }: PaletteSwatchPickerProps) {
  const current = value.toUpperCase();
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {colors.map((color) => {
        const checked = color.toUpperCase() === current;
        return (
          // A round color well, not Button-shaped: no Button variant draws a filled circle.
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={`Color ${color}`}
            onClick={() => onChange(color)}
            style={{ backgroundColor: color }}
            className={cn(
              'h-6 w-6 rounded-full transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
              checked && 'scale-110 ring-2 ring-primary ring-offset-1',
            )}
          />
        );
      })}
    </div>
  );
}
