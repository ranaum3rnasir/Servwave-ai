import { useRef, useState, type CSSProperties } from 'react';

import { PaletteSwatchPicker } from '@/components/form/PaletteSwatchPicker';
import { TAG_COLORS, TAG_COLOR_NAMES, tagColorName } from '@/lib/tag-colors';
import { Button } from '@/ui-kit/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';

/** The coloured dot. The colour is stored data, so it is passed as a custom property for the stylesheet to paint. */
export function ColourDot({ colour }: { colour: string }) {
  return <span aria-hidden className="lc-dot" style={{ '--c': colour } as CSSProperties} />;
}

/**
 * The Colour column button and its popover (spec 6.6): ten named swatches, the current one checked, "Selected: Grey"
 * under them. Picking the colour already set just closes; Escape closes and Radix returns focus to the button.
 */
export function ColourPopover({ name, colour, onPick }: { name: string; colour: string; onPick: (colour: string) => void }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const colourName = tagColorName(colour);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="lc-swb"
          aria-haspopup="dialog"
          aria-label={`Colour of ${name}: ${colourName}. Change colour`}
          title={`${colourName}. Change colour`}
        >
          <ColourDot colour={colour} />
          <span className="lc-swn" data-slot="lc-colour-name">
            {colourName}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        aria-label={`Colour for ${name}`}
        className="w-[252px] max-w-[calc(100vw-2rem)]"
        onOpenAutoFocus={(e) => {
          // Land on the checked swatch, as the mockup does.
          const target = bodyRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? bodyRef.current?.querySelector<HTMLElement>('[role="radio"]');
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
      >
        <div ref={bodyRef} className="flex flex-col gap-1">
          <PaletteSwatchPicker
            size="large"
            colors={TAG_COLORS}
            names={TAG_COLOR_NAMES}
            value={colour}
            onChange={(next) => {
              setOpen(false);
              if (next.toUpperCase() !== colour.toUpperCase()) onPick(next);
            }}
          />
          <p className="lc-swsel">
            Selected: <b>{colourName}</b>
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
