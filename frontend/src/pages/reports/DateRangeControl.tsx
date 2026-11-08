// ───────────────────────────────────────────────────────────────────────────
// DateRangeControl — Workiz-style date control for report pages.
//
// A single bordered card with two stacked rows:
//   • top    → the active preset (bold) + resolved date range (e.g.
//              "Jun 1st, 2026 – Jun 6th, 2026"), opens a preset menu
//   • bottom → "By: <date field>", opens a date-field menu
//
// Both menus are custom-styled (not native <select>) to match Workiz.
// ───────────────────────────────────────────────────────────────────────────
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { DatePicker } from '@/components/form/DatePicker';

import type { Opt } from '@/lib/reports/types';

const ord = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0] || 'th');
};
const fmtOrdinal = (d: Date) => `${d.toLocaleDateString('en-US', { month: 'short' })} ${ord(d.getDate())}, ${d.getFullYear()}`;

export function DateRangeControl({
  presets,
  preset,
  onPreset,
  from,
  to,
  fields,
  field,
  onField,
  customFrom,
  customTo,
  onCustomFrom,
  onCustomTo,
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
  const [open, setOpen] = useState<'preset' | 'field' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const presetLabel = presets.find((p) => p.key === preset)?.label ?? '';
  const fieldLabel = fields.find((f) => f.key === field)?.label ?? '';
  const rangeText = from && to ? `${fmtOrdinal(from)} – ${fmtOrdinal(to)}` : 'All dates';

  const menu = (opts: Opt[], current: string, choose: (k: string) => void) => (
    <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-border bg-surface-light py-1 shadow-lg">
      {opts.map((o) => (
        // raw: dropdown-menu-item / listbox-option row, not Button-shaped
        <button
          key={o.key}
          type="button"
          onClick={() => { choose(o.key); setOpen(null); }}
          className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-background-light ${
            o.key === current ? 'font-semibold text-text-primary' : 'text-text-primary'
          }`}
        >
          {o.label}
          {o.key === current && <Check className="h-4 w-4 text-primary" />}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={ref} className="relative w-72 rounded-lg border border-border bg-surface-light shadow-sm">
      {/* Preset row. raw: two-line select-style trigger (stacked title +
          resolved range) - no minted cell matches its stacked, borderless, no
          fixed height footprint, and outline/neutral's own border plus unset
          idle text colour (the documented trap) doesn't reproduce this
          borderless card row either. Not Button-shaped. */}
      <button
        type="button"
        onClick={() => setOpen((o) => (o === 'preset' ? null : 'preset'))}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-background-light/60"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-text-primary">{presetLabel}</span>
          <span className="block truncate text-xs text-text-secondary">{rangeText}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </button>

      <div className="border-t border-border" />

      {/* Date-field row - same two-line trigger shape as the preset row above,
          not Button-shaped - left raw. */}
      <button
        type="button"
        onClick={() => setOpen((o) => (o === 'field' ? null : 'field'))}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-background-light/60"
      >
        <span className="text-sm text-text-secondary">
          By: <span className="font-semibold text-text-primary">{fieldLabel}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </button>

      {/* Custom date inputs — shown when preset === 'custom' */}
      {preset === 'custom' && (
        <>
          <div className="border-t border-border" />
          <div className="flex items-center gap-2 px-4 py-2.5">
            <DatePicker
              aria-label="From"
              value={customFrom ?? ''}
              max={customTo || undefined}
              onChange={(v) => onCustomFrom?.(v)}
              inputClassName="h-9"
            />
            <span className="text-xs text-text-secondary">to</span>
            <DatePicker
              aria-label="To"
              value={customTo ?? ''}
              min={customFrom || undefined}
              onChange={(v) => onCustomTo?.(v)}
              inputClassName="h-9"
            />
          </div>
        </>
      )}

      {open === 'preset' && menu(presets, preset, onPreset)}
      {open === 'field' && menu(fields, field, onField)}
    </div>
  );
}
