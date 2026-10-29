import { MapPin } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';

import { EM } from '../glyphs';

/**
 * One row in the Job / Walkthrough pickers, in the shape the spec asks for:
 *
 *   line 1:  ID   Name
 *   line 2:  address
 *
 * The address is handed in already resolved (see `entityAddress.ts`) - this component
 * deliberately cannot reach a customer record, so there is nowhere for a customer-address
 * fallback to creep back in later. Blank address renders no second line at all rather
 * than an empty row with a floating pin.
 */
export interface EntityRowProps {
  /** Job number or lead number. */
  id: string | undefined;
  /** Customer NAME (the one thing the customer record is right for here). */
  name: string;
  /** Pre-resolved job/lead address. Empty string renders no second line. */
  address: string;
  /** Colour of the ID token - jobs and walkthroughs are told apart by it on the board too. */
  tone: 'job' | 'walkthrough';
  onSelect: () => void;
}

export function EntityRow({ id, name, address, tone, onSelect }: EntityRowProps) {
  return (
    <li>
      <Button
        variant="ghost"
        size="sm"
        className="h-auto w-full flex-col items-start gap-0 px-2 py-1.5 text-left font-normal"
        onClick={onSelect}
      >
        <span className="flex w-full items-center gap-2">
          <span
            className={`text-xs font-bold shrink-0 ${tone === 'job' ? 'text-brand' : 'text-status-amber-emphasis'}`}
          >
            {id ?? EM}
          </span>
          {name && <span className="text-xs text-muted-foreground truncate">{name}</span>}
        </span>
        {address && (
          <span className="flex w-full items-center gap-1 mt-0.5">
            <MapPin className="h-3 w-3 text-subtle-foreground shrink-0" />
            <span className="text-[11px] text-muted-foreground truncate">{address}</span>
          </span>
        )}
      </Button>
    </li>
  );
}
