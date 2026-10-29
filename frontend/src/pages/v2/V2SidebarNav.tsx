import { Fragment, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { useSidebar } from '@/ui-kit/components/layout/appShell';
import {
  SidebarGroupLabel, SidebarItem, SidebarNav,
} from '@/ui-kit/components/layout/nav/sidebar';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import {
  PLAN_LABELS, requiredPlanFor, useEntitlementsReady, useOrgFeatures,
} from '@/lib/entitlements';
import {
  getDestination, hasNavFeature, isDemoDestUnlockedForOrg, resolveNavHref,
  type NavAccess, type NavDestination,
} from '@/components/layout/nav-registry';
import { useNavLayout } from '@/components/layout/useNavLayout';

import { buildNavSections, type NavItem } from './buildNavSections';
import { NAV_SECTIONS } from './navSections';
import { preferV2Path } from './uiV2';

/**
 * The v2 sidebar's destination list.
 *
 * Split out of `V2AppLayout` because the list has enough of its own inputs -
 * ability, entitlements, demo-org state, the stored layout - to be worth
 * reading on its own.
 *
 * --- the layout is READ here, not written --------------------------------
 *
 * `useNavLayout()` is the per-user pinned-key order in localStorage, and the
 * legacy sidebar (`components/layout/Sidebar.tsx`) still offers the Customize
 * mode that writes it: drag to reorder, unpin a row, add a shortcut. The v2
 * shell once mirrored that mode and no longer does - it renders the saved order
 * and offers no way to change it, so a layout the user set in the legacy
 * sidebar is still honoured here, and nothing in this column can disagree with
 * what is stored.
 *
 * That also settles a question this shell had to answer and legacy never did:
 * the legacy sidebar is ONE flat list, so a drag can land anywhere in it, while
 * this one is bucketed by `NAV_SECTIONS`, which decides from a key which
 * heading a row appears under - a drag across headings would move the key in
 * the stored array and change nothing on screen. With no drag, there is no
 * cross-section case to define.
 */
export function V2SidebarNav() {
  const ability = useAppAbility();
  const navigate = useNavigate();
  const location = useLocation();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);

  const orgId = useAuthStore((s) => s.user?.organization_id);
  const orgFeatures = useOrgFeatures();
  const entitlementsReady = useEntitlementsReady();
  const isDemoOrg = useIsDemoOrg();
  const { keys } = useNavLayout();
  const { isRail } = useSidebar();

  /**
   * Explicit open/closed overrides per group key. A key with no entry is on
   * AUTO - open when one of its children is the current page - so landing on
   * `/inventory/vendors` from anywhere reveals the row you are standing on
   * without the user ever having opened the group. Same rule as legacy.
   */
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});

  /** A dirty settings form gets to intercept the navigation, as in legacy. */
  const guardNavigation = (href: string) => (event: MouseEvent) => {
    if (!useSettingsGuard.getState().isDirty) return;
    event.preventDefault();
    requestLeave(() => navigate(href));
  };

  /**
   * The registry's hrefs and the router's pathnames are now the same path
   * space - there is no `/v2` prefix to strip before comparing them - so the
   * pathname is used as-is, with the empty string standing in for `/` in case a
   * caller ever hands us one.
   */
  const currentPath = location.pathname || '/';
  const isActive = (href: string) =>
    href === '/'
      ? currentPath === '/'
      : currentPath === href || currentPath.startsWith(`${href}/`);

  const access: NavAccess = {
    can: (action, subject) => ability.can(action, subject),
    orgFeatures,
    entitlementsReady,
    isDemoOrg,
  };

  /** Locked on either axis: an entitlement the org lacks, or a demo-only
      surface in a real org. Gated on entitlementsReady so a cold cache cannot
      grey out every module on first paint - same reasoning as useFeature
      failing open. */
  const lockOf = (dest: NavDestination) => {
    const featureLocked = !hasNavFeature(dest.feature, access);
    const demoLocked = !!dest.demoOnly && !isDemoOrg && !isDemoDestUnlockedForOrg(dest, orgId);
    if (!featureLocked && !demoLocked) return null;
    // Only a PLAN lock may name a plan. A demo-only row that the org is fully
    // entitled to (WhatsApp on a Pro org) would otherwise be badged "Pro" and
    // read as an upsell for something already paid for.
    if (!featureLocked) return 'Soon';
    return PLAN_LABELS[requiredPlanFor(dest.feature) ?? ''] ?? 'Soon';
  };

  const sections = buildNavSections({
    keys,
    sections: NAV_SECTIONS,
    getDestination,
    can: (action, subject) => ability.can(action, subject),
    isLocked: (dest) => lockOf(dest) !== null,
    // Entitlement only, no demo axis - see the prop's doc comment. This is what
    // keeps a phone-gated child out of an email-only org's Communication group
    // while leaving a demo-only child in it, rendered locked.
    isFeatureLocked: (dest) => !hasNavFeature(dest.feature, access),
  });

  /**
   * Whether a group's child is the current page. A child whose href PREFIXES a
   * sibling's - Stock `/inventory` against Vendors `/inventory/vendors` - has
   * to match exactly, or it stays highlighted on every route in the group. The
   * legacy sidebar spells the same rule as NavLink's `end`.
   */
  const isActiveChild = ({ dest }: NavItem, siblings: NavItem[]) =>
    siblings.some((s) => s.dest.href !== dest.href && s.dest.href.startsWith(`${dest.href}/`))
      ? currentPath === dest.href
      : isActive(dest.href);

  /** One navigable row: a leaf, a group's child, or a group in rail mode. */
  const destinationRow = ({ key, dest }: NavItem, active: boolean, nested = false) => {
    const lock = lockOf(dest);
    const Icon = dest.icon;

    if (lock) {
      return (
        <SidebarItem key={key} locked nested={nested} icon={<Icon />} label={dest.label} count={lock} />
      );
    }

    // A GROUP's declared href is a fallback, not a truth: Communication is
    // declared at `/communication/phone`, which is a dead link for an org that
    // bought email but not phone. This row is only reached for a group in rail
    // mode (expanded mode renders a disclosure instead), and that is exactly
    // where a group is navigable, so it has to land somewhere reachable.
    const href = resolveNavHref(dest, access);

    return (
      <SidebarItem
        key={key}
        asChild
        nested={nested}
        active={active}
        icon={<Icon />}
        label={dest.label}
      >
        {/* Every destination in the registry is now a real route in this shell,
            so the href is the registry's own path. `preferV2Path` around it is a
            no-op shim kept for its call sites, not a rewrite - see `uiV2.ts`. */}
        <Link
          to={preferV2Path(href)}
          onClick={guardNavigation(preferV2Path(href))}
        />
      </SidebarItem>
    );
  };

  return (
    <SidebarNav>
      {sections.map(({ section, items }, index) => (
        <Fragment key={section}>
          {/* A fragment, not a wrapper element: the travelling rail measures
              each row's offsetTop against the nav's own box, so an extra
              positioned box between them would offset every measurement by
              the wrapper's origin. */}
          <SidebarGroupLabel withToggle={index === 0}>{section}</SidebarGroupLabel>
          {items.map((item) => {
            // Rail mode expands nothing. A 60px column has no room for a
            // nested list, and the labels that would name its rows are hidden
            // anyway - so the group renders as the plain destination its own
            // href points at (Inventory -> Stock, Communication -> Phone),
            // which is what the legacy sidebar does when it is collapsed.
            if (!item.children || isRail) return destinationRow(item, isActive(item.dest.href));

            // Auto-open on the PREFIX test rather than the exact one the rows
            // highlight with, so a sub-route no child names by itself still
            // opens the group it belongs to.
            const children = item.children;
            const open =
              groupOpen[item.key] ?? children.some((child) => isActive(child.dest.href));
            const Icon = item.dest.icon;

            return (
              <Fragment key={item.key}>
                {/* The parent toggles instead of navigating, so it never takes
                    the active state: the travelling rail belongs to whichever
                    child is the page, and the group's own href is reachable as
                    a child of its own (Stock, Phone). */}
                <SidebarItem
                  expanded={open}
                  icon={<Icon />}
                  label={item.dest.label}
                  onClick={() => setGroupOpen((state) => ({ ...state, [item.key]: !open }))}
                />
                {open
                  && children.map((child) => destinationRow(child, isActiveChild(child, children), true))}
              </Fragment>
            );
          })}
        </Fragment>
      ))}
    </SidebarNav>
  );
}
