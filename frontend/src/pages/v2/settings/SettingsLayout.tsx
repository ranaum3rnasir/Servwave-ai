import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { switchOn, useMySwitches } from '@/lib/api/mySwitches';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useAuthStore } from '@/stores/auth.store';
import type { AppAction, AppSubject } from '@/lib/ability';

import { Button } from '@/ui-kit/components/ui/button';
import { SelectField } from '@/ui-kit/components/form/selectField';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { toast } from '@/ui-kit/components/ui/sonner';
import { cn } from '@/ui-kit/lib/utils';

import { canSubmitSaver } from '@/lib/settings/types';

import { SettingsBarProvider, type SettingsSaver } from './settingsBar';
import { useRecordVisit } from '../pageBreadcrumbs';
import { isLegacyPaymentsTab } from './legacyPaymentsTabs';

interface NavItem {
  to: string;
  label: string;
  group: string;
  // Omit action/subject (and set always:true) for entries every authenticated
  // user may see regardless of CASL - e.g. self-service "My Profile".
  action?: AppAction;
  subject?: AppSubject;
  always?: boolean;
  // A switch the person must hold (from their own resolved switches) to see the entry, for a page whose switch
  // is display only and so has no rule to read.
  switchKey?: string;
  // Shown to Admins only (the flag on the signed-in person), whatever their switches: user and role management (AL-18), the phone
  // service and numbers (ticket 36), and the setup of the company (36b, M17). `orAction` adds a second door for a row that has one.
  adminOnly?: boolean;
  // A second CASL pair that ALSO shows the entry, for a page that serves a narrower audience
  // part of what it holds - e.g. ServWave Payments, whose payout card belongs to whoever holds
  // Manage payout account even without Edit company settings.
  orAction?: AppAction;
  orSubject?: AppSubject;
  // Additionally require communication-module access (the `phone` entitlement,
  // master switch for the whole Communication module), on top of the CASL
  // action/subject check - e.g. the Caller ID admin page.
  commGated?: boolean;
  // Additionally require the `email` entitlement - the Sender Address page.
  // Separate from commGated: email left the `phone` master switch as its own
  // entitlement (nav-registry.ts).
  emailGated?: boolean;
  // The page itself sends a visitor without the switch back to Settings, so it never becomes a step in the trail.
  redirectsWhenRefused?: boolean;
}

/** What the shell uses while the current page has registered no saver. */
const NO_SAVER: SettingsSaver = { save: () => {}, discard: () => {}, isDirty: false };

/**
 * Copied from the legacy `SettingsLayout.NAV` row for row - the labels are the
 * e2e selector surface (`getByRole('link', { name: 'Roles & Permissions' })`
 * and friends), the CASL pairs decide who sees each entry that is not `adminOnly` (an `adminOnly` entry follows the
 * Admin flag), and `commGated` /
 * `emailGated` decide which entries an entitlement hides. Renaming a label or
 * loosening a pair here is a behaviour change, not a restyle.
 *
 * THREE of these rows - Tax Rates, Sender Address and Custom Fields - point
 * at pages that were never rebuilt on the kit, so their routes mount the
 * ORIGINAL page components inside this shell (see
 * `routes/settings.routes.tsx`). They are listed here because the alternative
 * is three settings pages a user can only reach by typing the URL, which is the
 * same as losing them.
 */
const NAV: NavItem[] = [
  { to: 'profile', label: 'My Profile', group: 'ACCOUNT', always: true },
  // Setting up the company is the Admin flag's alone (36b, M17: the Company settings switch retired): nobody else sees these tabs,
  // whatever their switches or rules. Locations has its own switch and stays on it.
  { to: 'company', label: 'Company Profile', group: 'ORGANIZATION', adminOnly: true },
  { to: 'branding', label: 'Branding & Templates', group: 'ORGANIZATION', adminOnly: true },
  { to: 'locations', label: 'Locations', group: 'ORGANIZATION', action: 'read', subject: 'Location' },
  // User and role management is Admin-only (AL-18): nobody else sees these two tabs, whatever their switches.
  { to: 'users', label: 'Users & Teams', group: 'PEOPLE & ACCESS', adminOnly: true },
  { to: 'roles', label: 'Roles & Permissions', group: 'PEOPLE & ACCESS', adminOnly: true },
  // Every person's own sign-in (their password and email code) lives here, so the row is everyone's. The company's two-step policy
  // on the page is drawn for an Admin alone.
  { to: 'security', label: 'Login & Security', group: 'PEOPLE & ACCESS', always: true },
  // Configuration only (payments go-live P8): the attention list and the payments area live on the Payments page.
  // Whoever holds only Manage payout account still reaches the payout card, so that switch shows the row too.
  { to: 'servwave-payments', label: 'ServWave Payments', group: 'ADVANCED', adminOnly: true, orAction: 'manage_payout_account', orSubject: 'Organization' },
  // The org-owned lists (job types, sources, tags, task categories). Every change on it saves on its own.
  { to: 'lists', label: 'Lists', group: 'ADVANCED', adminOnly: true },
  // SRVW-112 - the CASL pair matches the backend write gate on /api/job-sub-statuses.
  { to: 'job-sub-statuses', label: 'Job Sub-Statuses', group: 'ADVANCED', adminOnly: true },
  // Decline-reasons slice B - the CASL pair matches the WRITE gate on /api/lost-reason-options.
  // Placed beside the other per-org vocabulary list (Job Sub-Statuses) rather than folded into
  // Lists: it is the same kind of settings surface that one is, and that page's lists
  // are a different shape entirely (string arrays on the organisation row, saved through the save bar).
  { to: 'decline-reasons', label: 'Estimate Decline Reasons', group: 'ADVANCED', adminOnly: true },
  // Roles & Permissions S06.14 - the job twin of the row above; the CASL pair matches the WRITE gate on /api/job-cancel-reasons.
  { to: 'job-cancel-reasons', label: 'Job Cancel Reasons', group: 'ADVANCED', adminOnly: true },
  // Org-owned tax rates: same CASL pair as the other org-list pages, matching
  // the write gate on /api/org-tax-rates.
  { to: 'tax-rates', label: 'Tax Rates', group: 'ADVANCED', adminOnly: true },
  // The phone service and phone numbers are an Admin's alone (M8, D3): nobody else sees these two tabs, whatever their switches.
  { to: 'phone-sms', label: 'Phone & SMS', group: 'ADVANCED', adminOnly: true },
  { to: 'phone-numbers', label: 'Caller ID', group: 'ADVANCED', adminOnly: true, commGated: true },
  // Email slice 10 (guided domain verification).
  { to: 'email-sender', label: 'Sender Address', group: 'ADVANCED', adminOnly: true, emailGated: true },
  { to: 'inventory', label: 'Inventory', group: 'ADVANCED', adminOnly: true },
  // Per-org scheduler event colours (2026-09-15). Same CASL pair: it writes PATCH /api/organization.
  { to: 'schedule-colors', label: 'Schedule Colors', group: 'ADVANCED', adminOnly: true },
  // Custom Fields (SRVW-114) is deliberately absent. Its tables and definitions
  // API ship dormant, but nobody has exercised the feature in a real org, so it is
  // not offered in the 2026-08-17 release. Restore this row together with the
  // route in `routes/settings.routes.tsx` once it has been QA'd.
];

/**
 * The v2 Settings shell.
 *
 * ROUTED tabs, not local state: each nav row is a `NavLink` onto a real nested
 * child route, so `/settings/roles` deep-links and every guard still applies
 * per tab. The pages with a door of their own (My Profile, Login & Security, Locations, ServWave Payments) carry NO
 * route guard; every other page sits under one RequireAdmin (pages/v2/routes/settings.routes.tsx), so a person who is
 * not an Admin and types its address gets nothing drawn and no reads made. The nav LIST is filtered the same way: an
 * `adminOnly` row follows the Admin flag, any other row its CASL pair.
 *
 * The four mechanisms of the unsaved-changes guard (#113) are carried across
 * whole: the zustand store, `beforeunload`, `popstate` with a seeded history
 * entry, and per-link `preventDefault`. Losing any one of them fails silently.
 */
export default function SettingsLayout() {
  const ability = useAppAbility();
  const isAdmin = useAuthStore((s) => s.user?.is_admin === true);
  const canComm = useFeature('phone');
  const canEmail = useFeature('email');
  // Undefined while loading or when the read fails: every switch counts as off.
  const mine = useMySwitches();
  const navigate = useNavigate();
  const location = useLocation();
  // The page's saver is remembered WITH the address it registered on. A page that registers nothing (Lists, or a
  // payout-only visitor's page) therefore never inherits the previous page's saver or its Save bar.
  const [registered, setRegistered] = useState<{ path: string; saver: SettingsSaver } | null>(null);
  const [saving, setSaving] = useState(false);
  const pathRef = useRef(location.pathname);
  // A layout effect, so the address is current before any page effect (a child's registerSaver) runs.
  useLayoutEffect(() => {
    pathRef.current = location.pathname;
  }, [location.pathname]);
  const hasSaver = registered?.path === location.pathname;
  const saver: SettingsSaver = hasSaver ? registered.saver : NO_SAVER;
  const { isDirty: guardDirty, pendingLeave, setDirty, requestLeave, resolvePending, cancelPending } =
    useSettingsGuard();

  const registerSaver = useCallback(
    (fns: SettingsSaver) => setRegistered({ path: pathRef.current, saver: fns }),
    [],
  );

  // #113 - publish the active page's dirty state so exit paths outside the shell
  // (the v2 topbar user menu, the sidebar, GlobalSearch) route through the same
  // confirm dialog. V2AppLayout already wraps every nav action in requestLeave;
  // this is the half that tells it there is anything to guard.
  useEffect(() => {
    setDirty(saver.isDirty);
  }, [saver.isDirty, setDirty]);

  // Reset the guard when the shell unmounts so other pages navigate freely.
  useEffect(() => {
    return () => {
      setDirty(false);
      cancelPending();
    };
  }, [setDirty, cancelPending]);

  // #113 - browser reload / tab close / external navigation.
  useEffect(() => {
    if (!guardDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [guardDirty]);

  // #113 - SPA Back/Forward. beforeunload does NOT fire on an in-app popstate,
  // and react-router's useBlocker is unavailable on this declarative router
  // (no data router - see settingsGuard.store.ts). So we guard popstate directly:
  // when dirty, immediately re-push the current entry to cancel the navigation,
  // then route the user's intended Back/Forward through the same confirm dialog.
  useEffect(() => {
    if (!guardDirty) return;
    const handler = () => {
      // The browser already popped; undo it so the page stays put...
      window.history.pushState(null, '', window.location.href);
      // ...then defer the real "leave settings" through the confirm dialog.
      requestLeave(() => navigate('/'));
    };
    // Seed one extra history entry so the first Back has something to cancel.
    window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [guardDirty, requestLeave, navigate]);

  // #112 - await + catch the saver so a failed save can't become an unhandled
  // rejection. Network/mutation failures toast their own detail (organization
  // mutations have onError toasts), so we must NOT double-toast those here. A
  // client-side ValidationError (e.g. Branding's invalid brand-color hex) has no
  // such toast, though - it would be swallowed, leaving only an inline field
  // message - so surface a toast for it. Keep the form editable either way.
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await saver.save();
      toast.success('Settings saved');
    } catch (err) {
      if (err instanceof Error && err.name === 'ValidationError') {
        toast.error("Couldn't save settings", { description: err.message });
      }
      // Other errors are surfaced by the mutation's onError toast.
    } finally {
      setSaving(false);
    }
  };

  const visible = NAV.filter(
    (n) =>
      (n.adminOnly
        // An Admin-only row is the flag's alone; the one exception is a row that names a second door of its own (ServWave Payments,
        // which the payout switch also opens).
        ? isAdmin || Boolean(n.orAction && n.orSubject && ability.can(n.orAction, n.orSubject))
        : n.always ||
          (n.switchKey && switchOn(mine?.values, n.switchKey)) ||
          (n.action && n.subject && ability.can(n.action, n.subject)) ||
          (n.orAction && n.orSubject && ability.can(n.orAction, n.orSubject))) &&
      (!n.commGated || canComm) &&
      (!n.emailGated || canEmail),
  );
  const groups = Array.from(new Set(visible.map((n) => n.group)));
  // Deliberately the same lookup as legacy, including its edge case: a deep-link
  // to a tab the user lacks CASL for leaves `current` undefined and the title
  // blank. Substituting a fallback title would change behaviour.
  const current = visible.find((n) => location.pathname.includes(`/settings/${n.to}`));
  // The bar belongs to a page that registered a saver. It stays hidden until the page's first effect has run (one
  // short beat on an editable page, no flicker after) and for good on a page that never registers.
  const hideSaveBar = !hasSaver;

  // Every settings page is a distinct URL, so each is its own step in the
  // trail; naming them all "Settings" would make walking between two of them
  // look like the trail had stalled.
  // A page the visitor has no nav entry for (a typed URL) still names itself: the trail would otherwise read
  // "Settings > Settings > Settings". The on-page title stays blank for it, as above.
  const named = current ?? NAV.find((n) => location.pathname.includes(`/settings/${n.to}`));
  // Two hops are not steps: a page that refuses the visitor and bounces them to Settings, and the bare /settings it
  // bounces through on the way to the first page they can open. After either, the trail names only where they are.
  const refusedRedirect = Boolean(named?.redirectsWhenRefused) && !current;
  const bareSettings = location.pathname.replace(/\/+$/, '') === '/settings';
  // An old ServWave Payments link that carries a known ?tab= passes through this shell on its way to the Payments page.
  const legacyTabHop =
    location.pathname === '/settings/servwave-payments' &&
    isLegacyPaymentsTab(new URLSearchParams(location.search).get('tab'));
  useRecordVisit(
    'settings',
    named ? `Settings · ${named.label}` : 'Settings',
    !refusedRedirect && !bareSettings && !legacyTabHop,
  );

  const guardedNav = (to: string) => requestLeave(() => navigate(to));

  return (
    <SettingsBarProvider value={{ registerSaver }}>
      <div className="flex gap-6">
        {/* Hidden below lg: a fixed 224px column left a phone page about 86px
            of room, and on an iPad or a phone on its side (768-838px, beside
            the app sidebar) about 260px, which pushed the header strip's Close
            off screen (mobile slice 29). The page picker replaces it there. */}
        <nav aria-label="Settings" className="hidden w-56 shrink-0 space-y-6 lg:block">
          {groups.map((g, gi) => (
            <div key={g} className={gi > 0 ? 'border-border border-t pt-5' : undefined}>
              <p className="text-muted-foreground mb-2 px-3 text-[11px] font-semibold uppercase tracking-widest">
                {g}
              </p>
              <div className="space-y-0.5">
                {visible
                  .filter((n) => n.group === g)
                  .map((n) => (
                    // A kit Button rendering the NavLink, not a styled anchor:
                    // the row keeps its `link` role and accessible name (the e2e
                    // specs select on `getByRole('link', { name })`), while the
                    // pressed/rest appearance stays inside the primitive.
                    // An ABSOLUTE `to`, matching the absolute child paths in
                    // settings.routes.tsx (relative resolution against an
                    // absolute child route is ambiguous, and the route file has
                    // to declare literals for uiV2.test.ts to see them).
                    <NavLink
                      key={n.to}
                      to={`/settings/${n.to}`}
                      onClick={(e) => {
                        if (saver.isDirty) {
                          e.preventDefault();
                          guardedNav(`/settings/${n.to}`);
                        }
                      }}
                    >
                      {({ isActive }) => (
                        <Button
                          asChild
                          size="sm"
                          variant={isActive ? 'secondary' : 'ghost'}
                          className={cn('w-full justify-start', isActive && 'font-semibold')}
                        >
                          <span>{n.label}</span>
                        </Button>
                      )}
                    </NavLink>
                  ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {/* Below lg: the same filtered entries as the side nav, as one
              compact picker, routed through the same unsaved-changes guard. */}
          <div className="mb-3 lg:hidden">
            <SelectField
              aria-label="Settings page"
              options={visible.map((n) => ({ value: n.to, label: n.label, group: n.group }))}
              value={current?.to}
              onValueChange={(to) => {
                if (to === current?.to) return;
                if (saver.isDirty) guardedNav(`/settings/${to}`);
                else navigate(`/settings/${to}`);
              }}
              placeholder="Choose a settings page"
              searchPlaceholder="Search settings"
              emptyMessage="No settings page matches."
            />
          </div>
          {/* One crumb strip for all thirteen settings pages, mounted on the
              LAYOUT rather than repeated on each of them. The label is the same
              `current` the title below uses, so a page reached by deep link
              with no CASL for it stays blank in both places rather than
              disagreeing with itself. Without this, Settings was a hole in the
              trail: every page under it recorded nothing at all. */}
          {/* Wraps (mobile slice 29): at 320px the page title beside Discard,
              Save and Close is wider than the screen, so the actions drop under
              the title rather than pushing Save and Close past the edge. */}
          <div className="border-border mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-3">
            <div className="min-w-0">
              <p className="text-muted-foreground text-[11px] font-semibold uppercase tracking-widest">
                Settings
              </p>
              {/* role/aria-level rather than an <h1>: the design-system raw-tag
                  ratchet sits at its floor for h1-h6. */}
              <p role="heading" aria-level={1} className="text-lg font-semibold">
                {current?.label ?? ''}
              </p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {/* Discard is gated on `isDirty` ALONE. Edits the page will not
                  write are still edits, and throwing them away is the one
                  action that is always safe - greying this out with Save would
                  trap the user in a form with no way out but a bad value. */}
              {!hideSaveBar && (
                <Button variant="ghost" size="sm" disabled={!saver.isDirty || saving} onClick={() => saver.discard()}>
                  Discard
                </Button>
              )}
              {/* Save reads BOTH signals: there must be something to save, and
                  the page must not be holding an edit it is going to refuse
                  (`canSave`, omitted by every page without a client-side rule).
                  Deriving this from `isDirty` alone left My Profile offering a
                  live Save for an unusable phone number, which sent nothing and
                  toasted an error - see canSubmitSaver in lib/settings/types. */}
              {!hideSaveBar && (
                <Button size="sm" disabled={!canSubmitSaver(saver) || saving} onClick={() => void handleSave()}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" aria-label="Close settings" onClick={() => guardedNav('/')}>
                <X />
              </Button>
            </div>
          </div>
          <Outlet />
        </div>
      </div>

      <Dialog open={!!pendingLeave} onOpenChange={(o) => !o && cancelPending()}>
        <DialogContent intent="choice">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => cancelPending()}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                saver.discard();
                resolvePending();
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsBarProvider>
  );
}
