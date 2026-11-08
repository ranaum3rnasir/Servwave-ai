import { Check, ChevronDown } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import type { Opt } from '@/lib/reports/types';

import { DatePicker } from '../../_shared/datePicker';

export type { Opt };

const ord = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0] || 'th');
};
const fmtOrdinal = (d: Date) =>
  `${d.toLocaleDateString('en-US', { month: 'short' })} ${ord(d.getDate())}, ${d.getFullYear()}`;

/**
 * The two-row date control the report pages put in their actions slot.
 *
 * Same shape as before - the active preset over its resolved range, then a
 * "By: <date field>" row, then the two custom-date inputs when the preset is
 * `custom`. Three things changed and nothing else:
 *
 *   - the card is the kit's `Card` instead of a hand-built bordered box;
 *   - each row's trigger is a kit `Button` opening a kit `DropdownMenu`,
 *     replacing a raw `<button>` plus an absolutely-positioned panel plus a
 *     `mousedown` listener on `document`;
 *   - the two custom-range fields are `_shared/datePicker`, which takes and
 *     returns the same `'YYYY-MM-DD'` strings the native inputs did and honours
 *     the same `min`/`max` bounds.
 *
 * The date-formatting helpers are duplicated rather than imported because they
 * are private to the legacy module (`ord`/`fmtOrdinal` are not exported); they
 * are four lines of pure arithmetic with no behaviour to drift.
 */
export function DateRangeControl({
  presets, preset, onPreset, from, to, fields, field, onField,
  customFrom, customTo, onCustomFrom, onCustomTo,
}: {
  presets: Opt[];
  preset: string;
  onPreset: (key: string) => void;
  from: Date | null;
  to: Date | null;
  fields: Opt[];
  field: string;
  onField: (key: string) => void;
  customFrom?: string;
  customTo?: string;
  onCustomFrom?: (v: string) => void;
  onCustomTo?: (v: string) => void;
}) {
  const presetLabel = presets.find((p) => p.key === preset)?.label ?? '';
  const fieldLabel = fields.find((f) => f.key === field)?.label ?? '';
  const rangeText = from && to ? `${fmtOrdinal(from)} - ${fmtOrdinal(to)}` : 'All dates';

  const menu = (opts: Opt[], current: string, choose: (k: string) => void) => (
    <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
      {opts.map((o) => (
        <DropdownMenuItem key={o.key} onSelect={() => choose(o.key)} className="justify-between">
          <span className={o.key === current ? 'font-semibold' : undefined}>{o.label}</span>
          {o.key === current && <Check />}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  );

  return (
    <Card className="w-72 gap-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size={null} className="h-auto w-full justify-between gap-2 px-4 py-2.5 text-left">
            <span className="min-w-0">
              <span className="text-foreground block text-[13px] font-semibold">{presetLabel}</span>
              <span className="text-muted-foreground block truncate text-[11.5px] font-normal">{rangeText}</span>
            </span>
            <ChevronDown className="shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        {menu(presets, preset, onPreset)}
      </DropdownMenu>

      <div className="border-t" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size={null} className="h-auto w-full justify-between gap-2 px-4 py-2.5 text-left">
            <span className="text-muted-foreground text-[13px] font-normal">
              By: <span className="text-foreground font-semibold">{fieldLabel}</span>
            </span>
            <ChevronDown className="shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        {menu(fields, field, onField)}
      </DropdownMenu>

      {preset === 'custom' && (
        <>
          <div className="border-t" />
          <div className="flex items-center gap-2 px-4 py-2.5">
            <DatePicker
              aria-label="From"
              value={customFrom ?? ''}
              max={customTo || undefined}
              onChange={(v) => onCustomFrom?.(v)}
              className="min-w-0 flex-1"
              inputClassName="h-9"
            />
            <span className="text-muted-foreground text-xs">to</span>
            <DatePicker
              aria-label="To"
              value={customTo ?? ''}
              min={customFrom || undefined}
              onChange={(v) => onCustomTo?.(v)}
              className="min-w-0 flex-1"
              inputClassName="h-9"
            />
          </div>
        </>
      )}
    </Card>
  );
}
