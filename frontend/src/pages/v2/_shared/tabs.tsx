import type { ReactNode } from 'react';

import { cn } from '@/ui-kit/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';

/**
 * A minimal tab strip built from kit primitives.
 *
 * The kit ships no Tabs component (21 UI primitives, none of them tabs), and
 * the app's own `components/ui/tabs` is off-limits to a v2 page, so the roles
 * are wired by hand here. The ARIA contract is the one the existing specs read:
 * `role="tablist"`, `role="tab"` with `aria-selected`, and a `role="tabpanel"`
 * per panel.
 */
export interface TabItem {
  value: string;
  label: ReactNode;
}

/** The strip's own frame - the rule it sits on and the inset its tabs start at. */
const STRIP_CLASS = 'flex flex-wrap items-center gap-1 border-b px-2';

export function TabStrip({
  tabs, value, onValueChange, className, right,
}: {
  tabs: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  /**
   * Page controls that belong ON the tab line rather than in a band above it -
   * a filter trigger, a view switch. They sit at the far end of the strip.
   *
   * Keep it to controls the height of a `size="sm"` Button: the strip's rule is
   * the wrapper's bottom border and the selected tab's indicator has to land on
   * it, so a taller slot would lift the tabs off their own underline. Anything
   * that WRAPS - a chip list - belongs under the strip, not in here.
   */
  right?: ReactNode;
}) {
  const triggers = tabs.map((tab) => {
    const selected = tab.value === value;
    return (
      <Button
        key={tab.value}
        role="tab"
        id={`v2-tab-${tab.value}`}
        aria-selected={selected}
        aria-controls={`v2-tabpanel-${tab.value}`}
        variant="ghost"
        size="sm"
        // The indicator is this border, so it already cross-fades on the
        // kit Button's own `transition-[...,border-color,...]` - only the
        // timing is ours: 240ms, the shell's own figure for a state change
        // with no travel (`.nav-rail { opacity 0.24s }`), so the strip
        // still answers the click while the panel takes its 460ms. tailwind-merge cannot see a named duration key,
        // so the Button's `duration-150` stays in the DOM alongside
        // `duration-fast`; the later rule wins, and that is the token one.
        // See the note on transitionDuration in tailwind.config.js - the
        // bracketed spelling that WOULD merge compiles to nothing.
        className={cn(
          'rounded-none border-b-2 border-transparent',
          'duration-fast ease-out-soft',
          'focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none',
          selected && 'border-brand text-foreground',
          !selected && 'hover:text-muted-foreground',
        )}
        onClick={() => onValueChange(tab.value)}
      >
        {tab.label}
      </Button>
    );
  });

  // Without a right slot the tablist IS the strip, byte for byte what every
  // existing caller already renders.
  if (!right) {
    return <div role="tablist" className={cn(STRIP_CLASS, className)}>{triggers}</div>;
  }

  // With one, the frame moves out to a wrapper so the slot shares the tabs'
  // line. The tablist keeps only the tabs - a filter button inside `role
  // ="tablist"` would be announced as a tab.
  return (
    <div className={cn(STRIP_CLASS, 'gap-x-3', className)}>
      <div role="tablist" className="flex min-w-0 flex-wrap items-center gap-1">
        {triggers}
      </div>
      <div className="ms-auto flex items-center gap-2">{right}</div>
    </div>
  );
}

export function TabPanel({
  value, activeValue, children,
}: {
  value: string;
  activeValue: string;
  children: ReactNode;
}) {
  if (value !== activeValue) return null;
  return (
    // The outgoing panel is unmounted above, so the swap was instant with
    // nothing to look at. `motion-safe:` is the whole reduced-motion story:
    // under `prefers-reduced-motion: reduce` the class never applies and the
    // panel is exactly the plain div it used to be.
    //
    // One class, two animations: a 20px glide over 460ms and a fade over
    // 300ms, both on the sidebar's own cubic-bezier(0.32, 0.72, 0, 1). The
    // pairing is the shell's - it travels for longer than it fades - and the
    // numbers are lifted from shell.css. See the `tab-panel-in` entry in
    // tailwind.config.js and the motion block in tokens-v2.css.
    <div
      role="tabpanel"
      id={`v2-tabpanel-${value}`}
      aria-labelledby={`v2-tab-${value}`}
      className="motion-safe:animate-tab-panel-in"
    >
      {children}
    </div>
  );
}
