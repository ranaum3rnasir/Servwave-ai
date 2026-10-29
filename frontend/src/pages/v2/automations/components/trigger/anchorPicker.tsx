import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';
import type { AnchorKey } from '@/lib/workflows/anchors';

/**
 * Step 3, date branch, above the timing: WHICH date the offset counts from.
 *
 * Rendered only when the subject offers more than one anchor. With a single option there is
 * nothing to choose and a lone locked chip would read as a broken control, so the caller drops
 * this panel entirely and the timing panel names the anchor on its own — exactly what every
 * subject did before the lead stage clocks arrived.
 *
 * The chip labels are the catalog's, verbatim. They are written to sit inside the sentence the
 * timing panel builds ("1 day before the walkthrough"), which is why they read as fragments here;
 * the heading supplies the missing half. Rewriting them client-side would re-introduce exactly the
 * hand-synced copy of the anchor vocabulary that serving the catalog removed.
 */

export interface AnchorOption {
  key: AnchorKey;
  label: string;
}

export interface AnchorPickerProps {
  options: AnchorOption[];
  value: AnchorKey | undefined;
  onPick: (key: AnchorKey) => void;
}

/** The pill chip look, matching DateModePanel's presets directly below it. */
function chipClass(active: boolean): string {
  return cn(
    'min-h-11 rounded-full px-3.5 text-[13px] font-bold',
    active
      ? 'border-primary bg-primary text-primary-foreground hover:opacity-90'
      : 'border-input bg-kit-card text-muted-foreground hover:border-brand',
  );
}

export default function AnchorPicker({ options, value, onPick }: AnchorPickerProps) {
  // Falls back to the first option rather than showing nothing selected: the caller always commits
  // an anchor on entering date mode, and a picker with no active chip would suggest the timing
  // below it is counting from nowhere.
  const selected = options.some((o) => o.key === value) ? value : options[0]?.key;

  return (
    <div>
      <p className="text-[15px] font-extrabold tracking-tight">What should it count from?</p>
      <p className="text-muted-foreground mb-3.5 mt-0.5 text-[12.5px]">
        Pick the moment the timing below counts from.
      </p>

      <div className="flex flex-wrap gap-2" role="group" aria-label="What should it count from?">
        {options.map((option) => {
          const active = option.key === selected;
          return (
            <Button
              key={option.key}
              type="button"
              variant="outline"
              aria-pressed={active}
              onClick={() => onPick(option.key)}
              className={chipClass(active)}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
