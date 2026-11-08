import type { AppAction, AppSubject } from '@/lib/ability';
import type { NavDestination } from '@/components/layout/nav-registry';

/**
 * The v2 sidebar's row list: resolve the user's pinned keys to destinations,
 * CASL-filter them, attach a group's children to it, bucket the result by
 * section.
 *
 * A PURE FUNCTION, deliberately, and separate from `V2AppLayout` even though it
 * has exactly one caller. The child rule it holds is the one that has already
 * shipped wrong twice - a group's child carried no entitlement, so on a Starter
 * org six locked modules rendered as live sidebar rows under two greyed-out
 * parents - and that is worth a test. Reaching it through the layout means
 * standing up an auth store, an ability, an entitlements cache, an org, the
 * copilot and the settings guard before the rule under test runs at all. Here
 * it is four arguments and a return value.
 *
 * The layout keeps everything that needs React: the lock LABEL (which plan
 * badge to show), the active-row test, the open/closed state of a group, and
 * the href rewriting.
 */

export interface NavSectionSpec {
  section: string;
  keys: readonly string[];
}

export interface NavItem {
  key: string;
  dest: NavDestination;
  /**
   * The rows nested under an expandable group, already CASL-filtered. Absent
   * on a leaf, and absent on a group with nothing left to show - so the
   * sidebar can treat "has children" as "render a disclosure" without having
   * to check for an empty one.
   */
  children?: NavItem[];
}

export interface NavSectionRows {
  section: string;
  items: NavItem[];
}

export interface BuildNavSectionsInput {
  /** The user's pinned keys, in the user's own order. */
  keys: readonly string[];
  /** Section headings and the keys each claims. */
  sections: readonly NavSectionSpec[];
  getDestination: (key: string) => NavDestination | undefined;
  /** The CASL check, as `ability.can`. */
  can: (action: AppAction, subject: AppSubject) => boolean;
  /**
   * Whether a destination is locked - an entitlement the org lacks, or a
   * demo-only surface in a real org. A boolean here rather than the plan badge
   * the layout renders, because the lift rule only asks the yes/no question.
   */
  isLocked: (dest: NavDestination) => boolean;
  /**
   * Whether a destination fails the ENTITLEMENT gate alone, ignoring demo-only.
   *
   * Separate from `isLocked` because a group's children are treated the two ways
   * legacy treats them (`Sidebar.tsx`: `visibleNavChildren` + `isNavChildLocked`):
   * an unentitled child is DROPPED - an org that never bought the module should
   * not be told what it is missing four times inside one group - while a
   * demo-only child STAYS and renders locked, which is the whole point of
   * `demoOnly` at child level.
   *
   * Optional so a caller that does not care (and every existing test) keeps the
   * old behaviour of gating children on `isLocked` alone.
   */
  isFeatureLocked?: (dest: NavDestination) => boolean;
}

export function buildNavSections({
  keys,
  sections,
  getDestination,
  can,
  isLocked,
  isFeatureLocked = isLocked,
}: BuildNavSectionsInput): NavSectionRows[] {
  const visible = keys
    .map((key) => ({ key, dest: getDestination(key) }))
    .filter((x): x is NavItem => !!x.dest && can(x.dest.action, x.dest.subject));

  const claimed = new Set(sections.flatMap((s) => [...s.keys]));

  return sections
    .map((section, index) => {
      const rows = visible
        // Anything no section claims lands in the last one rather than
        // vanishing, so a key the registry gains before this map does still
        // renders somewhere.
        .filter(({ key }) =>
          section.keys.includes(key)
          || (index === sections.length - 1 && !claimed.has(key)))
        // Two pinned keys can point at the same page; the first one wins.
        .filter((item, i, all) => all.findIndex((x) => x.dest.href === item.dest.href) === i);

      // The hrefs already reachable as a row of their own in this section.
      const pinnedHrefs = new Set(rows.map(({ dest }) => dest.href));

      return {
        section: section.section,
        // A destination with `children` (Inventory, Communication) is an
        // expandable group, as it is in the legacy sidebar: the parent row
        // toggles rather than navigates, and its children render nested
        // underneath it while it is open. They used to be LIFTED to flat
        // siblings here, because the kit's nav shipped no disclosure control;
        // it has one now (`SidebarItem expanded`), so the group survives the
        // port instead of being flattened into it.
        //
        // Each child is gated on its own ability, exactly as the parent is;
        // nesting a row must not nest its permission with it.
        //
        // A LOCKED parent yields no children. `NavChild` carries no `feature`
        // key of its own - the entitlement lives on the parent - so a child
        // used to read as unlocked no matter what the org owns. On a Starter
        // org that put six live rows in the sidebar (Purchase Orders, Vendors,
        // Assets, WhatsApp, Email, Text) under two greyed-out parents, each
        // bouncing to /upgrade on click. The legacy sidebar renders a locked
        // group as one greyed row with a plan badge and no children at all
        // (`Sidebar.tsx`: `childItems.length > 0 && ... && !locked`), which is
        // the behaviour reproduced here.
        //
        // `feature` and `comingSoon` are carried onto the child so an unlocked
        // group's rows still lock and badge on their own terms rather than
        // inheriting nothing.
        items: rows.map(({ key, dest }) => {
          if (isLocked(dest)) return { key, dest };

          const children = (dest.children ?? [])
            .filter((child) => can(child.action, child.subject))
            // A child that repeats a row already pinned in this section
            // renders once, as that row - Price Book is both its own registry
            // entry and an Inventory child. Its own parent's href is the
            // exception: the parent is a toggle rather than a link, so the
            // child carrying that href (Stock, Phone) is the only way in.
            .filter((child) => child.href === dest.href || !pinnedHrefs.has(child.href))
            .map((child) => ({
              key: child.key,
              dest: {
                ...child,
                home: dest.home,
                // The CHILD's own entitlement wins; the parent's is only a
                // fallback for a child that declares none. Overwriting it
                // unconditionally was the leak: Communication is entitled on
                // `['phone','email']` (OR), so an email-only org unlocks the
                // group, and stamping that array onto every child made
                // phone-gated Phone, WhatsApp and Text read as entitled too.
                feature: child.feature ?? dest.feature,
                comingSoon: child.comingSoon ?? dest.comingSoon,
              } as NavDestination,
            }))
            // Unentitled children are DROPPED, exactly as legacy's
            // `visibleNavChildren` drops them. Demo-only children survive this
            // filter and render locked - `isFeatureLocked` ignores that axis.
            .filter(({ dest: childDest }) => !isFeatureLocked(childDest));

          // No permitted child left means no group: an empty disclosure is a
          // control that does nothing.
          return children.length > 0 ? { key, dest, children } : { key, dest };
        }),
      };
    })
    .filter((section) => section.items.length > 0);
}
