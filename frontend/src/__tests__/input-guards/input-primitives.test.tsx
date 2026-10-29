/* =============================================================================
   Text entry primitives on touch, desktop untouched (mobile slice 14, KB-01).

   Every text entry primitive, and every wrapper over one, renders the touch
   floor `mobile:!text-base` (16 px everywhere except md-and-up with a fine
   pointer) whatever size its caller asks for, and otherwise renders EXACTLY
   the classes it rendered on staging before the slice: the classes are pinned
   in staging-text-entry-classes.json, captured from origin/staging
   (3fd952275) by running this file with WRITE_TEXT_ENTRY_BASELINE=1 before
   the primitives changed. Same classes through the same tailwind-merge means
   the same computed size on a desktop - including the two places the slice's
   first build got wrong: a legacy SelectField passed 'h-7 w-auto px-1
   text-xs' (12 px on a desktop) and a legacy Input passed 'text-[14.5px]'
   (14 px on a desktop, because the base's md:text-sm wins over it).

   The only other additions allowed are the focus indicators that replace a
   removed outline (A11Y-06), listed per case.
   ============================================================================= */
import * as React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Input as LegacyInput } from '@/components/ui/input';
import { Textarea as LegacyTextarea } from '@/components/ui/textarea';
import { Select as LegacySelect, SelectTrigger as LegacySelectTrigger, SelectValue as LegacySelectValue } from '@/components/ui/select';
import { Combobox as LegacyCombobox } from '@/components/ui/combobox';
import { SelectField as LegacySelectField } from '@/components/form/SelectField';
import { AutoGrowTextarea } from '@/components/ui/autoGrowTextarea';
import { Input as KitInput } from '@/ui-kit/components/ui/input';
import { Textarea as KitTextarea } from '@/ui-kit/components/ui/textarea';
import { Select as KitSelect, SelectTrigger as KitSelectTrigger, SelectValue as KitSelectValue } from '@/ui-kit/components/ui/select';
import { Command, CommandInput } from '@/ui-kit/components/ui/command';
import { Combobox as KitCombobox } from '@/ui-kit/components/form/combobox';
import { SelectField as KitSelectField } from '@/ui-kit/components/form/selectField';
import { DateField } from '@/ui-kit/components/form/dateField';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'staging-text-entry-classes.json');
const FLOOR = 'mobile:!text-base';
const noop = () => {};
const few = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];
const many = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));

interface Case {
  id: string;
  ui: () => React.ReactElement;
  /** The element whose classes are the field's. */
  pick: (c: HTMLElement) => Element | null;
  /** Expect no floor: the caller's own size is 16 px or more at every width. */
  large?: boolean;
  /** Classes this slice adds besides the floor (a focus indicator, A11Y-06). */
  added?: string[];
}

const byTag = (tag: string) => (c: HTMLElement) => c.querySelector(tag);
const trigger = (c: HTMLElement) => c.querySelector('[role="combobox"]');
const GHOST_FOCUS = ['focus-visible:outline-2', 'focus-visible:outline-offset-2', 'focus-visible:outline-primary'];
const COMMAND_FOCUS = ['focus-visible:shadow-[inset_0_-2px_0_0_rgb(var(--brand))]'];

const CASES: Case[] = [
  { id: 'legacy Input default', ui: () => <LegacyInput />, pick: byTag('input') },
  { id: 'legacy Input xs', ui: () => <LegacyInput size="xs" />, pick: byTag('input') },
  { id: 'legacy Input sm', ui: () => <LegacyInput size="sm" />, pick: byTag('input') },
  { id: 'legacy Input h-8 text-sm', ui: () => <LegacyInput className="h-8 text-sm" />, pick: byTag('input') },
  { id: 'legacy Input text-xs', ui: () => <LegacyInput className="text-xs" />, pick: byTag('input') },
  { id: 'legacy Input text-[11px]', ui: () => <LegacyInput className="h-7 text-[11px]" />, pick: byTag('input') },
  { id: 'legacy Input text-[14.5px] (AddItemDialog item name)', ui: () => <LegacyInput className="text-[14.5px]" />, pick: byTag('input') },
  { id: 'legacy Input business tone invalid', ui: () => <LegacyInput tone="business" invalid />, pick: byTag('input') },
  { id: 'legacy Input ghost', ui: () => <LegacyInput variant="ghost" />, pick: byTag('input'), added: GHOST_FOCUS },
  { id: 'legacy Input ghost text-sm', ui: () => <LegacyInput variant="ghost" className="flex-1 text-sm" />, pick: byTag('input'), added: GHOST_FOCUS },
  { id: 'legacy Input text-2xl title', ui: () => <LegacyInput className="text-2xl font-semibold" />, pick: byTag('input'), large: true },
  { id: 'legacy Textarea default', ui: () => <LegacyTextarea />, pick: byTag('textarea') },
  { id: 'legacy Textarea sm', ui: () => <LegacyTextarea size="sm" />, pick: byTag('textarea') },
  { id: 'legacy Textarea text-[11px]', ui: () => <LegacyTextarea className="text-[11px]" />, pick: byTag('textarea') },
  {
    id: 'legacy SelectTrigger default',
    ui: () => (
      <LegacySelect value="a">
        <LegacySelectTrigger><LegacySelectValue /></LegacySelectTrigger>
      </LegacySelect>
    ),
    pick: trigger,
  },
  {
    id: 'legacy SelectTrigger xs',
    ui: () => (
      <LegacySelect value="a">
        <LegacySelectTrigger size="xs"><LegacySelectValue /></LegacySelectTrigger>
      </LegacySelect>
    ),
    pick: trigger,
  },
  {
    id: 'legacy SelectField h-7 w-auto px-1 text-xs (InternalCostsCard overhead mode)',
    ui: () => <LegacySelectField options={few} value="a" onValueChange={noop} className="h-7 w-auto px-1 text-xs" />,
    pick: trigger,
  },
  { id: 'legacy SelectField text-sm', ui: () => <LegacySelectField options={few} value="a" onValueChange={noop} className="text-sm" />, pick: trigger },
  { id: 'legacy SelectField searchable text-xs', ui: () => <LegacySelectField options={many} value="v1" onValueChange={noop} className="h-8 text-xs" />, pick: trigger },
  { id: 'legacy Combobox text-[11px]', ui: () => <LegacyCombobox options={many} value="v1" onValueChange={noop} className="text-[11px]" />, pick: trigger },
  // `overscroll-contain`: the box scrolls once it reaches its cap, so a flick at its end must not drag the page (mobile slice 75, rubric SCR-01).
  { id: 'AutoGrowTextarea text-sm', ui: () => <AutoGrowTextarea className="text-sm" />, pick: byTag('textarea'), added: ['overscroll-contain'] },
  { id: 'kit Input default', ui: () => <KitInput />, pick: byTag('input') },
  { id: 'kit Input text-[13.5px]', ui: () => <KitInput className="text-[13.5px]" />, pick: byTag('input') },
  { id: 'kit Input with icon', ui: () => <KitInput startIcon={<span />} className="h-8 text-xs" />, pick: byTag('input') },
  { id: 'kit Input text-lg', ui: () => <KitInput className="text-lg" />, pick: byTag('input'), large: true },
  { id: 'kit Textarea default', ui: () => <KitTextarea />, pick: byTag('textarea') },
  { id: 'kit Textarea text-[13px]', ui: () => <KitTextarea className="text-[13px]" />, pick: byTag('textarea') },
  {
    id: 'kit SelectTrigger default',
    ui: () => (
      <KitSelect value="a">
        <KitSelectTrigger><KitSelectValue /></KitSelectTrigger>
      </KitSelect>
    ),
    pick: trigger,
  },
  {
    id: 'kit SelectTrigger sm text-xs',
    ui: () => (
      <KitSelect value="a">
        <KitSelectTrigger size="sm" className="text-xs"><KitSelectValue /></KitSelectTrigger>
      </KitSelect>
    ),
    pick: trigger,
  },
  {
    id: 'kit CommandInput',
    ui: () => (
      <Command>
        <CommandInput placeholder="Search" />
      </Command>
    ),
    pick: byTag('input'),
    added: COMMAND_FOCUS,
  },
  { id: 'kit Combobox', ui: () => <KitCombobox options={many} value="v1" onValueChange={noop} />, pick: trigger },
  { id: 'kit Combobox text-xs', ui: () => <KitCombobox options={many} value="v1" onValueChange={noop} className="text-xs" />, pick: trigger },
  { id: 'kit SelectField text-xs', ui: () => <KitSelectField options={few} value="a" onValueChange={noop} className="h-8 text-xs" />, pick: trigger },
  { id: 'kit SelectField searchable', ui: () => <KitSelectField options={many} value="v1" onValueChange={noop} />, pick: trigger },
  { id: 'kit DateField inputClassName text-xs', ui: () => <DateField value="" onChange={noop} inputClassName="text-xs" />, pick: byTag('input') },
];

function classesOf(c: Case): string[] {
  const { container, unmount } = render(c.ui());
  const el = c.pick(container);
  if (!el) throw new Error(`${c.id}: element not found`);
  const out = el.getAttribute('class')!.split(/\s+/).filter(Boolean);
  unmount();
  return out;
}

if (process.env.WRITE_TEXT_ENTRY_BASELINE) {
  const out: Record<string, string[]> = {};
  for (const c of CASES) out[c.id] = classesOf(c);
  fs.writeFileSync(FIXTURE, `${JSON.stringify(out, null, 1)}\n`);
}

const staging: Record<string, string[]> = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

describe('text entry primitives: 16 px on touch, staging classes kept (mobile slice 14)', () => {
  for (const c of CASES) {
    it(c.id, () => {
      const now = classesOf(c);
      const before = staging[c.id];
      expect(before, `${c.id} has no staging capture`).toBeDefined();
      if (c.large) expect(now).not.toContain(FLOOR);
      else expect(now).toContain(FLOOR);
      // Desktop: exactly the staging classes, plus only the floor
      // (a `mobile:` class, which a desktop never matches) and any listed focus indicator.
      const extra = new Set([FLOOR, ...(c.added ?? [])]);
      // Sorted: the order of classes in the attribute does not change what CSS applies.
      expect(now.filter((k) => !extra.has(k)).sort()).toEqual(before!.filter((k) => !extra.has(k)).sort());
      for (const k of c.added ?? []) expect(now).toContain(k);
    });
  }
});
