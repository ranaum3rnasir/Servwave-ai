import * as React from 'react';

import {
  Tabs,
  TabsList,
  TabsTrigger,
  type TabsListVariant,
  type TabsTriggerVariant,
} from '@/components/ui/tabs';
import type { PadStep } from '@/design-system/spacing';

/* =============================================================================
   TabStrip - phase 11.6. Retires DetailPageShell (program plan section
   "11.6 - DetailPageShell is retired in favour of TabStrip", owner decision
   2026-07-30).

   WHY THIS IS NARROWER THAN DetailPageShell, ON PURPOSE.
   DetailPageShell reached 11 configuration props across its 6 real call
   sites, 8 of them conditional on a single `card` boolean, and only one of
   the six adopters (InvoiceDetailPage) rendered its default shape. That is
   not a shape every page shares - it is one page's shape plus five sets of
   overrides wearing a shared component's clothes. Re-measured against the
   six call sites at build time (not carried from the plan's own table): the
   ONLY thing genuinely identical across all six is generating a `<TabsList>`
   trigger row from a `{ value, label, disabled? }[]` array and wiring it to
   a controlled active tab. The Card InvoiceDetailPage wraps itself in, the
   scroll rail TasksHubPage wraps itself in, and the tinted content tray
   JobDetailPage wraps itself in are each ONE page's own structure - they are
   now plain JSX at each call site, not a prop on this component.

   DELETED, AND NOT REPLACED BY ANYTHING: `card`, `tabsSurface`,
   `listClassName`, `railWrapperClassName`, `railWrapperTestId`,
   `contentWrapperClassName`. A caller wanting a card wraps its own
   `<Card pad={0}>` around `<TabStrip>`; a caller wanting a scroll rail or a
   tinted tray writes its own wrapping `<div>`. See each migrated page for
   the real shape - CustomerDetailPage, JobDetailPage and LeadDetailPage each
   keep a page-level wrapper, and CustomerDetailPage in particular no longer
   has a way to express its old `gap-0` trigger-row override (a documented,
   accepted visual difference - see that page's own comment above its
   `TabStrip` call).

   NO REF, NO `className`, NO PASSTHROUGH `...props`. Every prior adopter
   site is re-verified at migration time to need none of them - see the
   commit that added this file. Adding an escape hatch nothing currently
   asks for is exactly the accretion this retirement exists to undo; a page
   that later needs one is a signal to grow this file's *props table*
   (`tabs`/`active`/`onChange`/`padX`/`padTop`/`listVariant`/
   `triggerVariant`/`triggerClassName`, nothing else), not to reopen a
   generic override channel.

   `listVariant` / `triggerVariant` HAVE NO DEFAULT HERE. TabsList and
   TabsTrigger already default to `'line'` themselves - restating that
   default on this component would just be a second place for the same fact
   to drift out of sync, so it is left undefined and forwarded as-is.

   `label` ON A TAB IS `React.ReactNode`, NOT `string` - carried over
   unchanged from DetailPageShell. InvoiceDetailPage pairs every label with a
   count badge (`Line Items (12)`), so a string-only prop would not
   reproduce that call site.

   ZERO APPEARANCE TOKENS AUTHORED HERE, CHECKED AGAINST THE GUARD, NOT
   ASSUMED. Every value this file passes to `TabsList`/`TabsTrigger` is
   forwarded as an IDENTIFIER (`padX={padX}`, `className={triggerClassName}`),
   never a literal string typed into a JSX attribute here, so
   `component-api-guard.test.ts`'s per-tag scan - which only reads quoted
   string segments inside a `className=...` attribute - has nothing to count
   no matter what a call site passes in. `components/patterns` is ratcheted
   to a directory-wide appearance ceiling of 0
   (`DIR_CEILINGS['components/patterns']`); this file inherits that floor
   the same way DetailPageShell, Toolbar and FormField already did.
   ============================================================================= */

export interface TabStripTab {
  /** Matches the `value` passed to the corresponding `<TabsContent>` child. */
  value: string;
  /** Rendered inside the trigger - a plain label, or label plus a count badge. */
  label: React.ReactNode;
  disabled?: boolean;
}

export interface TabStripProps {
  tabs: TabStripTab[];
  active: string;
  onChange: (value: string) => void;
  /** The `<TabsContent>` panels, passed through unchanged - never restructured into an array. */
  children: React.ReactNode;
  /** Forwarded to `TabsList`'s own padding contract. No default - a strip passed neither emits no padding class. */
  padX?: PadStep;
  padTop?: PadStep;
  /** Forwarded to `TabsList`. Default: `TabsList`'s own default (`'line'`). */
  listVariant?: TabsListVariant;
  /** Forwarded uniformly to every generated `TabsTrigger`. Default: `TabsTrigger`'s own default (`'line'`). */
  triggerVariant?: TabsTriggerVariant;
  /** className applied uniformly to every generated `TabsTrigger`. Default: none. */
  triggerClassName?: string;
}

/**
 * Generates a `<TabsList>` trigger row from `tabs` and wires it to a
 * controlled active tab - the one shape genuinely shared across every
 * adopting page. Everything around it (a card, a scroll rail, a tinted
 * content tray) is the call site's own JSX now; see plan section 11.6.
 */
function TabStrip({ tabs, active, onChange, children, padX, padTop, listVariant, triggerVariant, triggerClassName }: TabStripProps) {
  return (
    <Tabs value={active} onValueChange={onChange}>
      <TabsList variant={listVariant} padX={padX} padTop={padTop}>
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            disabled={tab.disabled}
            variant={triggerVariant}
            className={triggerClassName}
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  );
}
TabStrip.displayName = 'TabStrip';

export { TabStrip };
