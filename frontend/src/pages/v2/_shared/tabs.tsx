import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

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
const STRIP_CLASS = 'flex flex-nowrap items-center gap-1 border-b px-2';

/**
 * The tabs' own row. ONE row, always (mobile slice 03): on a phone the job
 * page's ten tabs used to wrap onto two or three rows and eat a third of a 320
 * screen. Now the row scrolls sideways inside itself. The scrollbar is hidden
 * because the cut-off tab at the edge already says "there is more", and a
 * visible bar would sit on top of the selected tab's underline.
 */
const ROW_CLASS = 'flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden';

/**
 * Marks the row as a sideways scroller that scrolls ON PURPOSE. The mobile
 * gate (e2e/mobile/README.md) fails any element that scrolls sideways without
 * this marker, because on most pages that is a layout bug; here it is the
 * design. Set on the row only, never on the wrapper, so a right-hand control
 * that overflows is still caught.
 */
const INTENDED_SCROLLER = { 'data-mobile-scroll-x': 'tab-strip' } as const;

/** Room left beside a tab scrolled into view, so its neighbour shows it is not the last one. */
const SCROLL_MARGIN = 24;

/**
 * Bring `tab` fully inside `row`'s visible width by moving the ROW's own
 * scrollLeft. Deliberately not `scrollIntoView`: that also scrolls the page,
 * so a job opened on a phone would jump down to the tab strip on load.
 */
function scrollTabIntoRow(row: HTMLElement, tab: HTMLElement) {
  if (row.scrollWidth <= row.clientWidth) return;
  const rowRect = row.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  if (tabRect.left < rowRect.left) {
    row.scrollLeft -= rowRect.left - tabRect.left + SCROLL_MARGIN;
  } else if (tabRect.right > rowRect.right) {
    row.scrollLeft += tabRect.right - rowRect.right + SCROLL_MARGIN;
  }
}

/** The tab a roving key lands on, or null for a key the strip does not own. */
function nextIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight': return (current + 1) % count;
    case 'ArrowLeft': return (current - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

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
  const rowRef = useRef<HTMLDivElement>(null);

  // `aria-controls` may only name a panel that is in the page (axe: aria-valid-attr-value, critical, on
  // the selected tab). Most pages render a TabPanel for the selected tab, but a strip that routes
  // (inventory) or whose panels are not ours has none, and the attribute is optional. So the
  // selected tab gets it only once its panel exists. Set on the DOM after every render of the strip
  // (not through a prop, and not through state): React never owns the attribute, so it cannot undo it.
  useLayoutEffect(() => {
    rowRef.current?.querySelectorAll<HTMLElement>('[role="tab"]').forEach((el) => {
      const panel = `v2-tabpanel-${el.id.replace(/^v2-tab-/, '')}`;
      if (el.getAttribute('aria-selected') === 'true' && document.getElementById(panel)) el.setAttribute('aria-controls', panel);
      else el.removeAttribute('aria-controls');
    });
  });

  // Keep the selected tab in view, on load and whenever the selection changes
  // (a deep link to the 8th tab, or a page that switches tab itself). Layout
  // effect, so the row is already scrolled on the first painted frame.
  useLayoutEffect(() => {
    const row = rowRef.current;
    const selected = row?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (row && selected) scrollTabIntoRow(row, selected);
  }, [value]);

  // Arrow keys, Home and End move focus along the row (the WAI-ARIA tabs
  // pattern, manual activation): Enter or Space - the button's own click -
  // still picks the tab, so arrowing past a tab does not load its panel. The
  // tab order is left as it was: every tab is still a Tab stop.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rowRef.current;
    if (!row) return;
    const items = Array.from(row.querySelectorAll<HTMLElement>('[role="tab"]'));
    const current = items.indexOf(event.target as HTMLElement);
    if (current === -1) return;
    const next = nextIndex(event.key, current, items.length);
    const target = next === null ? undefined : items[next];
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
    scrollTabIntoRow(row, target);
  };

  const triggers = tabs.map((tab) => {
    const selected = tab.value === value;
    return (
      <Button
        key={tab.value}
        role="tab"
        id={`v2-tab-${tab.value}`}
        aria-selected={selected}
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
          'shrink-0 rounded-none border-b-2 border-transparent',
          'duration-fast ease-out-soft',
          // Inset: the row scrolls sideways, and a scroller clips vertically
          // too, so an outside ring would lose its top and bottom edges.
          'focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/25 focus-visible:outline-none',
          selected && 'border-brand text-foreground',
          !selected && 'hover:text-muted-foreground',
        )}
        onClick={() => onValueChange(tab.value)}
      >
        {tab.label}
      </Button>
    );
  });

  // Without a right slot the tablist IS the strip: the frame and the
  // scrolling row are one element, as every existing caller renders it.
  if (!right) {
    return (
      <div ref={rowRef} role="tablist" {...INTENDED_SCROLLER} className={cn(STRIP_CLASS, ROW_CLASS, className)} onKeyDown={onKeyDown}>
        {triggers}
      </div>
    );
  }

  // With one, the frame moves out to a wrapper so the slot shares the tabs'
  // line. The tablist keeps only the tabs - a filter button inside `role
  // ="tablist"` would be announced as a tab. The tabs give way (they scroll);
  // the slot keeps its width.
  return (
    <div className={cn(STRIP_CLASS, 'gap-x-3', className)}>
      <div ref={rowRef} role="tablist" {...INTENDED_SCROLLER} className={ROW_CLASS} onKeyDown={onKeyDown}>
        {triggers}
      </div>
      <div className="ms-auto flex shrink-0 items-center gap-2">{right}</div>
    </div>
  );
}

export function TabPanel({
  value, activeValue, keepMounted = false, children,
}: {
  value: string;
  activeValue: string;
  /**
   * Keep the panel mounted, hidden, while another tab is open, so what is typed into it survives a
   * tab switch (a form with unsaved edits). `hidden` is display:none, so the panel is out of the
   * accessibility tree and the tab order while it waits. Off by default: most panels should not
   * keep their queries and state alive behind a tab nobody is looking at.
   */
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const active = value === activeValue;
  if (!active && !keepMounted) return null;
  return (
    // The outgoing panel is unmounted (or hidden) above, so the swap was instant with
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
      // Revealing a kept panel takes it from display:none back to shown, which replays the same
      // entrance animation a fresh mount gets.
      hidden={!active}
      className="motion-safe:animate-tab-panel-in"
    >
      {children}
    </div>
  );
}
