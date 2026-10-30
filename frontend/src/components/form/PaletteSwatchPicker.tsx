import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';

interface PaletteSwatchPickerProps {
  /** The palette, in display order - persisted `#RRGGBB` values, not theme tokens. */
  colors: readonly string[];
  value: string;
  onChange: (color: string) => void;
  /** Accessible name of the group. Defaults to "Color". */
  'aria-label'?: string;
  /**
   * A name for each colour, in the same order as `colors` (for example "Violet"). With names, a swatch's accessible
   * name and tooltip are the colour's name instead of "Color #8B5CF6". Omit it and nothing changes for existing callers.
   */
  names?: readonly string[];
  /**
   * `large` is the Settings > Lists swatch: a 32px target (44px on a phone) with a round dot and a check on the selected
   * one. The default is the small ring swatch every other picker uses.
   */
  size?: 'default' | 'large';
  className?: string;
}

/**
 * Pick one color from a fixed palette: a row of round swatches with radio semantics (one group,
 * one checked), so a screen reader hears "Color #22C55E, radio, checked, 4 of 10".
 *
 * The swatch is painted with an inline style for the same reason the tag chips are: the color is
 * stored data, not a theme token. Matching is case-insensitive, so a stored lower-case hex still
 * shows as selected.
 */
export function PaletteSwatchPicker({ colors, value, onChange, 'aria-label': ariaLabel = 'Color', names, size = 'default', className }: PaletteSwatchPickerProps) {
  const current = value.toUpperCase();
  const large = size === 'large';
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('flex flex-wrap', large ? 'gap-1' : 'gap-1.5', className)}>
      {colors.map((color, i) => {
        const checked = color.toUpperCase() === current;
        const name = names?.[i];
        return (
          // A round color well, not Button-shaped: no Button variant draws a filled circle.
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={name ?? `Color ${color}`}
            title={name}
            onClick={() => onChange(color)}
            style={large ? undefined : { backgroundColor: color }}
            className={cn(
              'rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
              large
                ? 'relative grid h-11 w-11 shrink-0 place-items-center min-[641px]:h-8 min-[641px]:w-8'
                : cn('h-6 w-6 transition-transform', checked && 'scale-110 ring-2 ring-primary ring-offset-1'),
            )}
          >
            {large && (
              <>
                <span
                  aria-hidden
                  style={{ backgroundColor: color }}
                  className={cn(
                    'h-7 w-7 rounded-full border-2 border-text-primary/30 min-[641px]:h-[22px] min-[641px]:w-[22px]',
                    checked && 'ring-2 ring-text-primary ring-offset-2 ring-offset-surface-light',
                  )}
                />
                {checked && <Check aria-hidden strokeWidth={3} className="absolute size-3 text-on-fill drop-shadow" />}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
