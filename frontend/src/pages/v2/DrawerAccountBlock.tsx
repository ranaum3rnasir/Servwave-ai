import { LogOut, Settings as SettingsIcon, X } from 'lucide-react';

import { ClockInOutMenu } from '@/components/timeclock/ClockInOutMenu';
import { useSidebar } from '@/ui-kit/components/layout/appShell';
import { SidebarItem } from '@/ui-kit/components/layout/nav/sidebar';

export interface DrawerAccountBlockProps {
  name: string;
  email?: string;
  initials: string;
  /** Background for the initials chip (the kit's avatar tint scale). */
  tint?: string;
  /** The organisation's logo, shown instead of the initials when there is one. */
  avatarSrc?: string;
  avatarAlt?: string;
  onSettings: () => void;
  onSignOut: () => void;
}

/**
 * Who you are and what you can do about it, at the top of the navigation drawer.
 *
 * The avatar menu on wide screens carries the geofenced clock, Settings and Sign Out; a phone has no
 * room for that chip in the top bar, so the drawer carries the same three here, and the top bar's
 * overflow menu does not repeat them. The clock is the existing `ClockInOutMenu`, unchanged: the
 * running timer, the location steps and the inline clock-out confirm are all its own.
 *
 * Renders nothing outside the drawer. It is its own component, not markup in `V2AppLayout`, because
 * it needs `useSidebar()`, which only resolves for a component rendered inside `AppShell`.
 */
export function DrawerAccountBlock({
  name, email, initials, tint, avatarSrc, avatarAlt, onSettings, onSignOut,
}: DrawerAccountBlockProps) {
  const { isDrawer, isRailTier, closeDrawer } = useSidebar();
  // Phones only. The tablet rail's overlay is laid out like the drawer too, but the top bar's
  // avatar menu is on screen at that width and already carries these three.
  if (!isDrawer || isRailTier) return null;

  return (
    <section aria-label="Account" className="sb-account">
      <div className="sb-account-who">
        {avatarSrc ? (
          <span className="tb-avatar">
            <img src={avatarSrc} alt={avatarAlt ?? ''} />
          </span>
        ) : (
          <span className="tb-avatar" style={{ backgroundColor: tint }} aria-hidden>
            {initials}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="sb-account-name">{name}</span>
          {email && <span className="sb-account-email">{email}</span>}
        </span>
        <button type="button" className="sb-account-close" aria-label="Close navigation" onClick={closeDrawer}>
          <X aria-hidden />
        </button>
      </div>

      <div className="sb-account-clock">
        <ClockInOutMenu />
      </div>

      <SidebarItem icon={<SettingsIcon />} label="Settings" onClick={onSettings} />
      <SidebarItem icon={<LogOut />} label="Sign Out" onClick={onSignOut} />
    </section>
  );
}
