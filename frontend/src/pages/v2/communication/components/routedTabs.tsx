import type { ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { cn } from '@/ui-kit/lib/utils';

/**
 * The Communication module's URL-driven tab plumbing.
 *
 * The STRIP itself is `pages/v2/_shared/tabs.tsx` - the kit ships no
 * Tabs primitive and every module has needed one, so this file adds no tenth
 * version of it. What lives here is the part leads does not have: reading the
 * active tab out of the route and writing it back.
 *
 * Both `/communication/phone/:tab` and `/communication/text/:tab` are ROUTED
 * tabs, so the URL is the source of truth. The read order and the write target
 * are the legacy pages' exactly:
 *
 *   read   `params.tab` -> `?tab=` -> the default, with an unknown value
 *          silently falling back to the default (no 404, no redirect)
 *   write  the SEARCH param only
 *
 * Those two do not agree, and that is reproduced rather than fixed: from
 * `/communication/phone/numbers`, choosing "Call flows" navigates to
 * `/communication/phone/numbers?tab=flows` and the page stays on numbers,
 * because the path param still wins on the next read. The legacy comment at
 * PhonePage.tsx says the search write was meant "to keep both forms in sync",
 * which is exactly what it does not do. Fixing it here would change where a
 * click lands - behaviour, not presentation - so it is logged in the ledger
 * instead.
 */
export function useRoutedTab<T extends string>(keys: readonly T[], fallback: T) {
  const params = useParams<{ tab?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const raw = params.tab ?? searchParams.get('tab') ?? fallback;
  const active: T = (keys as readonly string[]).includes(raw) ? (raw as T) : fallback;

  function goToTab(next: T) {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp);
  }

  return { active, goToTab };
}

/**
 * A tab panel that can own the height of the page.
 *
 * `_shared/tabs.tsx` exports a `TabPanel`, but its div carries no
 * layout at all, and every Communication panel is a full-height three-pane or
 * a scroll region - a panel that cannot be told to fill its parent collapses
 * the pane. Same ARIA contract and the same id scheme as that file, so a spec
 * written against either reads both.
 */
export function ModuleTabPanel({
  value, activeValue, className, children,
}: {
  value: string;
  activeValue: string;
  className?: string;
  children: ReactNode;
}) {
  if (value !== activeValue) return null;
  return (
    <div
      role="tabpanel"
      id={`v2-tabpanel-${value}`}
      aria-labelledby={`v2-tab-${value}`}
      className={cn('min-h-0 flex-1', className)}
    >
      {children}
    </div>
  );
}
