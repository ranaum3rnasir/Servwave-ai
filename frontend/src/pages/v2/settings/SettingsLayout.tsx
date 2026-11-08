import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { X } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import type { AppAction, AppSubject } from '@/lib/ability';

import { Button } from '@/ui-kit/components/ui/button';
import { SelectField } from '@/ui-kit/components/form/selectField';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { toast } from '@/ui-kit/components/ui/sonner';
import { cn } from '@/ui-kit/lib/utils';

import { SettingsBarProvider, type SettingsSaver } from './settingsBar';
import { useRecordVisit } from '../pageBreadcrumbs';

interface NavItem {
  to: string;
  label: string;
  group: string;
  // Omit action/subject (and set always:true) for entries every authenticated
  // user may see regardless of CASL - e.g. self-service "My Profile".
  action?: AppAction;
  subject?: AppSubject;
  always?: boolean;
  // Additionally require communication-module access (the `phone` entitlement,
  // master switch for the whole Communication module), on top of the CASL
  // action/subject check - e.g. the Caller ID admin page.
  commGated?: boolean;
  // Additionally require the `email` entitlement - the Sender Address page.
  // Separate from commGated: email left the `phone` master switch as its own
  // entitlement (nav-registry.ts).
  emailGated?: boolean;
}

/**
 * Copied from the legacy `SettingsLayout.NAV` row for row - the labels are the
 * e2e selector surface (`getByRole('link', { name: 'Roles & Permissions' })`
 * and friends), the CASL pairs decide who sees each entry, and `commGated` /
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
  { to: 'company', label: 'Company Profile', group: 'ORGANIZATION', action: 'read', subject: 'Organization' },
  { to: 'branding', label: 'Branding & Templates', group: 'ORGANIZATION', action: 'read', subject: 'Organization' },
  { to: 'locations', label: 'Locations', group: 'ORGANIZATION', action: 'read', subject: 'Location' },
  { to: 'users', label: 'Users & Teams', group: 'PEOPLE & ACCESS', action: 'update', subject: 'User' },
  { to: 'roles', label: 'Roles & Permissions', group: 'PEOPLE & ACCESS', action: 'read', subject: 'Role' },
  { to: 'security', label: 'Login & Security', group: 'PEOPLE & ACCESS', action: 'read', subject: 'Organization' },
  { to: 'payments', label: 'Payments & Lists', group: 'ADVANCED', action: 'update', subject: 'Organization' },
  // SRVW-112 - the CASL pair matches the backend write gate on /api/job-sub-statuses.
  { to: 'job-sub-statuses', label: 'Job Sub-Statuses', group: 'ADVANCED', action: 'update', subject: 'Organization' },
  // Decline-reasons slice B - the CASL pair matches the WRITE gate on /api/lost-reason-options.
  // Placed beside the other per-org vocabulary list (Job Sub-Statuses) rather than folded into
  // Payments & Lists: it is the same kind of settings surface that one is, and that page's lists
  // are a different shape entirely (string arrays on the organisation row, saved through the save bar).
  { to: 'decline-reasons', label: 'Estimate Decline Reasons', group: 'ADVANCED', action: 'update', subject: 'Organization' },
  // Org-owned tax rates: same CASL pair as the other org-list pages, matching
  // the write gate on /api/org-tax-rates.
  { to: 'tax-rates', label: 'Tax Rates', group: 'ADVANCED', action: 'update', subject: 'Organization' },
  { to: 'phone-sms', label: 'Phone & SMS', group: 'ADVANCED', action: 'update', subject: 'Organization' },
  { to: 'phone-numbers', label: 'Caller ID', group: 'ADVANCED', action: 'update', subject: 'Organization', commGated: true },
  // Email slice 10 (guided domain verification).
  { to: 'email-sender', label: 'Sender Address', group: 'ADVANCED', action: 'update', subject: 'Organization', emailGated: true },
  { to: 'inventory', label: 'Inventory', group: 'ADVANCED', action: 'update', subject: 'Organization' },
  // Per-org scheduler event colours (2026-09-15). Same CASL pair: it writes PATCH /api/organization.
  { to: 'schedule-colors', label: 'Schedule Colors', group: 'ADVANCED', action: 'update', subject: 'Organization' },
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
 * per tab. The routes themselves carry NO role guard - that is App.tsx's shape
 * and it is reproduced exactly. Only the nav LIST is CASL-filtered, so a
 * technician who types a settings URL still mounts the page and still degrades
 * into the API's own 403-driven empty state, with no redirect and no toast.
 *
 * The four mechanisms of the unsaved-changes guard (#113) are carried across
 * whole: the zustand store, `beforeunload`, `popstate` with a seeded history
 * entry, and per-link `preventDefault`. Losing any one of them fails silently.
 */
export default function SettingsLayout() {
  const ability = useAppAbility();
  const canComm = useFeature('phone');
  const canEmail = useFeature('email');
  const navigate = useNavigate();
  const location = useLocation();
  const [saver, setSaver] = useState<SettingsSaver>({ save: () => {}, discard: () => {}, isDirty: false });
  const [saving, setSaving] = useState(false);
  const { isDirty: guardDirty, pendingLeave, setDirty, requestLeave, resolvePending, cancelPending } =
    useSettingsGuard();

  const registerSaver = useCallback((fns: SettingsSaver) => setSaver(fns), []);

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
      (n.always || (n.action && n.subject && ability.can(n.action, n.subject))) &&
      (!n.commGated || canComm) &&
      (!n.emailGated || canEmail),
  );
  const groups = Array.from(new Set(visible.map((n) => n.group)));
  // Deliberately the same lookup as legacy, including its edge case: a deep-link
  // to a tab the user lacks CASL for leaves `current` undefined and the title
  // blank. Substituting a fallback title would change behaviour.
  const current = visible.find((n) => location.pathname.includes(`/settings/${n.to}`));

  // Every settings page is a distinct URL, so each is its own step in the
  // trail; naming them all "Settings" would make walking between two of them
  // look like the trail had stalled.
  useRecordVisit('settings', current ? `Settings · ${current.label}` : 'Settings');

  const guardedNav = (to: string) => requestLeave(() => navigate(to));

  return (
    <SettingsBarProvider value={{ registerSaver }}>
      <div className="flex gap-6">
        {/* Hidden below sm: a fixed 224px column left a phone page about 86px
            of room. The page picker above the content replaces it there. */}
        <nav aria-label="Settings" className="hidden w-56 shrink-0 space-y-6 sm:block">
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
          {/* Phone only: the same filtered entries as the side nav, as one
              compact picker, routed through the same unsaved-changes guard. */}
          <div className="mb-3 sm:hidden">
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
          <div className="border-border mb-4 flex items-center justify-between border-b pb-3">
            <div>
              <p className="text-muted-foreground text-[11px] font-semibold uppercase tracking-widest">
                Settings
              </p>
              {/* role/aria-level rather than an <h1>: the design-system raw-tag
                  ratchet sits at its floor for h1-h6. */}
              <p role="heading" aria-level={1} className="text-lg font-semibold">
                {current?.label ?? ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={!saver.isDirty || saving} onClick={() => saver.discard()}>
                Discard
              </Button>
              <Button size="sm" disabled={!saver.isDirty || saving} onClick={() => void handleSave()}>
                {saving ? 'Saving...' : 'Save Changes'}
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Close settings" onClick={() => guardedNav('/')}>
                <X />
              </Button>
            </div>
          </div>
          <Outlet />
        </div>
      </div>

      <Dialog open={!!pendingLeave} onOpenChange={(o) => !o && cancelPending()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>You have unsaved changes that will be lost.</DialogDescription>
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
