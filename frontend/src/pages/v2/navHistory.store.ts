import { create } from 'zustand';

import { NAV_REGISTRY } from '@/components/layout/nav-registry';

/**
 * The last few pages the user actually visited, oldest to newest.
 *
 * The v2 breadcrumb is a TRAIL, not a hierarchy: it answers "how did I get
 * here" rather than "where does this page sit in the nav tree". Nothing else in
 * the app knows that - react-router keeps a history stack but will not tell you
 * what was on it, and the browser's own entries carry no labels - so the pages
 * record themselves as they render (see `pageBreadcrumbs.tsx`).
 *
 * A module-level store rather than state in the layout: the crumb is rendered
 * per page, inside PageHeader, and every page that unmounts on navigation would
 * otherwise take the trail with it.
 */

export interface NavVisit {
  /** The router pathname, which is both the identity and the link target. */
  path: string;
  /** What the crumb reads. */
  label: string;
}

/** Crumbs rendered. */
export const TRAIL_LENGTH = 4;

/**
 * How many visits are kept. Larger than what renders, so that walking back
 * (which truncates) re-reveals context that had scrolled off the trail rather
 * than leaving a stub of one or two crumbs.
 */
export const HISTORY_CAP = 8;

/**
 * Routes that are never a step in a journey: the ones you pass THROUGH on the
 * way in, and the public token pages, which are not part of the authed app at
 * all and whose links would 404 for the signed-in user reading the crumb.
 */
const EXCLUDED_PATHS = ['/login', '/auth/callback', '/accept-invite'];

export function isRecordablePath(path: string): boolean {
  if (EXCLUDED_PATHS.includes(path)) return false;
  return path !== '/p' && !path.startsWith('/p/');
}

/**
 * Tab paths that are one page, keyed by the section path they collapse to.
 *
 * `/inventory` is a SINGLE page (`InventoryPage`) whose tab strip deep-links
 * each view - see its `VIEW_PATHS`. Deep-linkable tabs are the right call for
 * the alert bus, but they mean switching tab changes the pathname, and the
 * trail keys on pathname. So clicking through Stock, Assets and Activity used
 * to append three crumbs and read as a journey across three unrelated pages,
 * which is not what looking around one page is.
 *
 * Collapsing them to the section makes a tab switch a no-op for the trail: the
 * path is already the head, so `visit` returns the same state object. The tab
 * views correspondingly do NOT name themselves (no `useRecordVisit`), or the
 * crumb's LABEL would churn on every tab while its path sat still.
 *
 * Only tabs of one page belong here. `/inventory/vendors`, `/inventory/price-book`
 * and `/inventory/purchase-orders` are separate route components and separate
 * sidebar destinations - going to one of those IS navigation, and each keeps
 * its own crumb.
 */
const SECTION_TAB_PATHS: Record<string, readonly string[]> = {
  '/inventory': [
    '/inventory/staging',
    '/inventory/assets',
    '/inventory/low-stock',
    '/inventory/activity',
    '/inventory/logistic-orders',
  ],
};

/**
 * The path a visit is recorded under: itself, unless it is a tab of a page that
 * already has its own crumb.
 *
 * Applied inside the store rather than at each call site so it covers both ways
 * a path gets in - a page naming itself through `useRecordVisit`, and the
 * layout's `visitFallback` for a path nothing claimed.
 */
export function canonicalPath(path: string): string {
  for (const [section, tabs] of Object.entries(SECTION_TAB_PATHS)) {
    if (tabs.some((tab) => path === tab || path.startsWith(`${tab}/`))) return section;
  }
  return path;
}

/**
 * Where one user's trail is kept.
 *
 * Keyed BY USER, and that is the point: this browser profile is shared between
 * the owner and whoever is at the front desk on the shop's one machine, and a
 * trail is a record of where somebody has been. Signing in as someone else must
 * not hand you their last four pages, and signing back in should return your
 * own.
 *
 * The user id is PUSHED IN through `hydrate`, never pulled from the auth store
 * here. This module is imported by a dozen page modules, most of which have
 * nothing to do with auth, and reaching into `useAuthStore` from it made every
 * one of them fail in any suite that stubs the auth module - which is most of
 * them. The store's job is "keep a trail under the key I am given"; deciding
 * who is signed in is the layout's.
 */
function storageKeyFor(userId: string | null): string | null {
  return userId ? `servwave_v2_nav_trail:${userId}` : null;
}

/**
 * The trail as last written by this user, or empty.
 *
 * Every failure is swallowed to empty rather than thrown. localStorage is
 * unavailable in private-mode Safari and disabled by some managed-device
 * policies, and JSON.parse throws on anything a previous version wrote in a
 * different shape. None of that is worth breaking a page header over - the
 * worst case is the crumb starting fresh, which is what it did before it was
 * persisted at all.
 */
function loadVisits(key: string | null): NavVisit[] {
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is NavVisit =>
          typeof entry === 'object' && entry !== null &&
          typeof (entry as NavVisit).path === 'string' &&
          typeof (entry as NavVisit).label === 'string',
      )
      .filter((entry) => isRecordablePath(entry.path))
      .slice(-HISTORY_CAP);
  } catch {
    return [];
  }
}

function saveVisits(key: string | null, visits: NavVisit[]): void {
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(visits));
  } catch {
    /* quota or a disabled store - the trail simply does not survive the reload */
  }
}

interface NavHistoryState {
  visits: NavVisit[];
  /**
   * The localStorage key this trail is written to, or null for "do not
   * persist". Null until `hydrate` is given a user, which is also what makes an
   * unauthenticated session - and every test that never calls `hydrate` -
   * in-memory only.
   */
  storageKey: string | null;
  /** Record the page being rendered. Safe to call on every render. */
  visit: (path: string, label: string) => void;
  /**
   * Record a page that named itself nothing better.
   *
   * The safety net under the whole trail. Any page that calls `visit` (via
   * `useRecordVisit`) supplies a real label and wins; this
   * only fires for a path nothing has claimed. React runs a child's effects
   * BEFORE its parent's, so by the time the layout calls this, a page that was
   * going to record itself already has - which is why this can be a no-op on a
   * path that is already the head of the trail rather than needing to know
   * which pages opted in.
   *
   * It exists because "add a crumb to every page" is a rule that decays: it
   * held for fifteen pages and not for the twenty-five others, and every miss
   * showed up as the trail apparently resetting itself. A page added next month
   * is covered by this without anyone remembering the rule.
   */
  visitFallback: (path: string, label: string) => void;
  /**
   * Adopt a user and load their stored trail. Called by the layout on mount and
   * whenever the signed-in user changes; pass null to stop persisting.
   */
  hydrate: (userId: string | null) => void;
  clear: () => void;
}

export const useNavHistory = create<NavHistoryState>((set, get) => ({
  visits: [],
  storageKey: null,

  visit: (rawPath, label) =>
    set((state) => {
      const path = canonicalPath(rawPath);
      if (!isRecordablePath(path)) return state;

      const { visits } = state;
      const last = visits[visits.length - 1];

      // Already here. A detail page renames itself once its data lands, so the
      // label is updated in place; an identical call returns the SAME state
      // object, which is what keeps the recording effect from looping.
      if (last?.path === path) {
        if (last.label === label) return state;
        return { visits: persisted([...visits.slice(0, -1), { path, label }]) };
      }

      // Back to somewhere we have been: everything after it is no longer how we
      // got here, so it goes. Without this, A -> B -> A -> B grows forever.
      const seen = visits.findIndex((visit) => visit.path === path);
      if (seen >= 0) return { visits: persisted([...visits.slice(0, seen), { path, label }]) };

      return { visits: persisted([...visits, { path, label }].slice(-HISTORY_CAP)) };
    }),

  visitFallback: (rawPath, label) =>
    set((state) => {
      const path = canonicalPath(rawPath);
      if (!isRecordablePath(path)) return state;
      // Somebody already spoke for this path - theirs is the better name.
      if (state.visits[state.visits.length - 1]?.path === path) return state;

      const seen = state.visits.findIndex((entry) => entry.path === path);
      if (seen >= 0) return { visits: persisted([...state.visits.slice(0, seen), { path, label }]) };
      return { visits: persisted([...state.visits, { path, label }].slice(-HISTORY_CAP)) };
    }),

  hydrate: (userId) => {
    const key = storageKeyFor(userId);
    set({ storageKey: key, visits: loadVisits(key) });
  },

  clear: () => {
    const { storageKey: key } = get();
    if (key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* nothing to do - see saveVisits */
      }
    }
    set({ visits: [] });
  },
}));

/**
 * Write-through. Every branch above that produces a new trail routes through
 * here, so there is no path that updates the in-memory trail and forgets the
 * stored one - the two cannot drift.
 */
function persisted(visits: NavVisit[]): NavVisit[] {
  saveVisits(useNavHistory.getState().storageKey, visits);
  return visits;
}

/** The crumbs to render: the most recent visits, oldest to newest. */
export function trailOf(visits: NavVisit[]): NavVisit[] {
  return visits.slice(-TRAIL_LENGTH);
}

/**
 * A serviceable name for a path, from the path alone.
 *
 * Only ever used by `visitFallback`, for a page that named itself nothing. It
 * resolves the module segment against the nav registry, so the name matches
 * what the sidebar calls the same destination, and falls back to the segment
 * itself title-cased. A detail page therefore lands in the trail as "Jobs"
 * rather than as its record number - worse than the page could have done, and
 * far better than not appearing at all.
 *
 * The module segment is the FIRST one. It used to be the second, because every
 * pathname here began with the `/v2` prefix that no longer exists; reading
 * index 1 now returns the record id on `/jobs/J00042` and nothing at all on
 * `/schedule`, which is how the trail lost its labels.
 */
export function fallbackLabelFor(pathname: string): string {
  const segment = pathname.split('/').filter(Boolean)[0];
  if (!segment) return 'Home';

  const dest = NAV_REGISTRY.find((d) => d.href === `/${segment}`);
  if (dest) return dest.label;

  return segment
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
