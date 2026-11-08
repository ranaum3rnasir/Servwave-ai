import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { toast } from '@/components/ui/use-toast';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { AppAction, AppSubject } from '@/lib/ability';

import type { SettingsSaver } from '@/lib/settings/types';

interface SettingsCtx {
  registerSaver: (fns: SettingsSaver) => void;
}

const Ctx = createContext<SettingsCtx>({ registerSaver: () => {} });
export const useSettingsBar = () => useContext(Ctx);

interface NavItem {
  to: string;
  label: string;
  group: string;
  // Omit action/subject (and set always:true) for entries every authenticated
  // user may see regardless of CASL — e.g. self-service "My Profile".
  action?: AppAction;
  subject?: AppSubject;
  always?: boolean;
  // Additionally require communication-module access (demo / allowlisted org),
  // on top of the CASL action/subject check — e.g. the Caller ID admin page.
  commGated?: boolean;
  // Additionally require the `email` entitlement — e.g. the Email Domain
  // admin page (email slice 10). Separate from commGated: email left the
  // `phone` master switch as its own entitlement (nav-registry.ts).
  emailGated?: boolean;
}

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
  // Org-owned tax rates: same CASL pair as the other org-list pages, matching the write gate on
  // /api/org-tax-rates.
  { to: 'tax-rates', label: 'Tax Rates', group: 'ADVANCED', action: 'update', subject: 'Organization' },
  { to: 'phone-sms', label: 'Phone & SMS', group: 'ADVANCED', action: 'update', subject: 'Organization' },
  { to: 'phone-numbers', label: 'Caller ID', group: 'ADVANCED', action: 'update', subject: 'Organization', commGated: true },
  // Email slice 10 (guided domain verification).
  { to: 'email-sender', label: 'Sender Address', group: 'ADVANCED', action: 'update', subject: 'Organization', emailGated: true },
  { to: 'inventory', label: 'Inventory', group: 'ADVANCED', action: 'update', subject: 'Organization' },
  { to: 'custom-fields', label: 'Custom Fields', group: 'ADVANCED', action: 'update', subject: 'Organization' },
];

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

  // #113 — publish the active page's dirty state so exit paths outside the shell
  // (Header user menu, role switch) can route through the same confirm dialog.
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

  // #113 — browser reload / tab close / external navigation.
  useEffect(() => {
    if (!guardDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [guardDirty]);

  // #113 — SPA Back/Forward. beforeunload does NOT fire on an in-app popstate,
  // and react-router's useBlocker is unavailable on this declarative router
  // (no data router — see settingsGuard.store.ts). So we guard popstate directly:
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

  // #112 — await + catch the saver so a failed save can't become an unhandled
  // rejection. Network/mutation failures toast their own detail (organization
  // mutations have onError toasts), so we must NOT double-toast those here. A
  // client-side ValidationError (e.g. Branding's invalid brand-color hex) has no
  // such toast, though — it would be swallowed, leaving only an inline field
  // message — so surface a toast for it. Keep the form editable either way.
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await saver.save();
      toast({ title: 'Settings saved' });
    } catch (err) {
      if (err instanceof Error && err.name === 'ValidationError') {
        toast({
          variant: 'destructive',
          title: "Couldn't save settings",
          description: err.message,
        });
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
  const current = visible.find((n) => location.pathname.includes(`/settings/${n.to}`));

  const guardedNav = (to: string) => requestLeave(() => navigate(to));

  return (
    <Ctx.Provider value={{ registerSaver }}>
      <div className="flex gap-6">
        <nav className="w-56 shrink-0 space-y-6">
          {groups.map((g, gi) => (
            <div key={g} className={gi > 0 ? 'border-t border-border pt-5' : undefined}>
              <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-widest text-text-secondary/70">{g}</p>
              <div className="space-y-0.5">
                {visible
                  .filter((n) => n.group === g)
                  .map((n) => (
                    <NavLink
                      key={n.to}
                      to={n.to}
                      onClick={(e) => {
                        if (saver.isDirty) {
                          e.preventDefault();
                          guardedNav(`/settings/${n.to}`);
                        }
                      }}
                      className={({ isActive }) =>
                        `block rounded-lg px-3 py-2 text-sm transition-colors ${
                          isActive
                            ? 'bg-primary-subtle font-semibold text-primary'
                            : 'font-medium text-text-primary hover:bg-background-light'
                        }`
                      }
                    >
                      {n.label}
                    </NavLink>
                  ))}
              </div>
            </div>
          ))}

        </nav>

        <div className="min-w-0 flex-1">
          <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary/70">Settings</p>
              <Heading level={1} scale="lg">{current?.label ?? ''}</Heading>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={!saver.isDirty || saving} onClick={() => saver.discard()}>
                Discard
              </Button>
              <Button size="sm" disabled={!saver.isDirty || saving} onClick={() => void handleSave()}>
                {saving ? 'Saving…' : 'Save Changes'}
              </Button>
              <Button variant="ghost" size="icon" onClick={() => guardedNav('/')}>
                <X className="h-4 w-4" />
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
              variant="solid" tone="danger"
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
    </Ctx.Provider>
  );
}
