import { useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';

/**
 * The help icon beside a switch. It shows the catalog's text for that switch, as written: hover opens it with a
 * mouse, a tap opens it on a touch screen (a hover tooltip never shows there), and Enter opens it from the keyboard.
 * Its accessible name is "About {label}", unless a screen's approved copy gives the whole name (`ariaLabel`).
 */
export function HelpIcon({ label, text, ariaLabel }: { label: string; text: string; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const pointer = useRef<string>('mouse');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={ariaLabel ?? `About ${label}`}
          className="size-6 shrink-0 rounded-full"
          onPointerDown={(e) => {
            pointer.current = e.pointerType;
          }}
          onKeyDown={() => {
            pointer.current = 'keyboard';
          }}
          onPointerEnter={(e) => {
            if (e.pointerType === 'mouse') setOpen(true);
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setOpen(false);
          }}
          onClick={(e) => {
            // The trigger's own toggle would close what the hover just opened.
            e.preventDefault();
            setOpen((wasOpen) => (pointer.current === 'mouse' ? true : !wasOpen));
          }}
        >
          <HelpCircle />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="text-xs"
        // Plain text: nothing in it to focus, so opening it leaves the focus where it was.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {text}
      </PopoverContent>
    </Popover>
  );
}
