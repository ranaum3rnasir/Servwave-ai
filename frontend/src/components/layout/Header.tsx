import { useNavigate } from 'react-router-dom';
import { LogOut, MessageSquare, Mail, HelpCircle, MoreVertical, CircleUser as UserIcon, Settings as SettingsIcon } from 'lucide-react';
import type { ComponentType } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { getInitials } from '@/lib/utils';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import GlobalSearch from './GlobalSearch';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { GlobalDialer } from '@/components/communication/phone/Dialer';
import { useOrganization } from '@/lib/api/organization';
import { useUnreadCounts } from '@/lib/api/communication';
import { useFeature } from '@/lib/entitlements';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useAppAbility } from '@/contexts/AbilityContext';
import CopilotLauncher from '@/components/copilot/CopilotLauncher';
import { ClockInOutMenu } from '@/components/timeclock/ClockInOutMenu';
import { useIsClockedIn } from '@/lib/api/timeclock';

// WhatsApp brand glyph (lucide ships no brand icons). Single-path, uses currentColor.
function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.821 11.821 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884a9.86 9.86 0 0 0 1.51 5.26l-.999 3.648 3.978-1.042zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.297.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413z" />
    </svg>
  );
}

function CommsButton({
  icon: Icon,
  count,
  label,
  onClick,
  iconClassName,
}: {
  icon: ComponentType<{ className?: string }>;
  count: number;
  label: string;
  onClick: () => void;
  iconClassName?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      aria-label={label}
      onClick={onClick}
    >
      <Icon className={`h-5 w-5 ${iconClassName ?? ''}`} />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-notify px-1 text-[10px] font-semibold leading-none text-on-fill">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Button>
  );
}

// A labeled row inside the mobile overflow menu (kebab). Mirrors a header
// shortcut as a readable menu item with an optional unread badge.
function OverflowItem({
  icon: Icon,
  label,
  count,
  onClick,
  iconClassName,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  count?: number;
  onClick: () => void;
  iconClassName?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-sm text-text-primary transition-colors hover:bg-background-light"
    >
      <Icon className={`h-4 w-4 ${iconClassName ?? ''}`} />
      <span className="flex-1 text-left">{label}</span>
      {count != null && count > 0 && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-notify px-1 text-[10px] font-semibold leading-none text-on-fill">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

// Raw by design (both call sites of the raw <button> in this file):
// - OverflowItem below is a manually-built popover menu row (icon + label +
//   badge) - the dropdown-menu-item shape, not a Button.
// - The account/avatar DropdownMenuTrigger's asChild target further down mixes
//   an Avatar + two lines of user text; the Button primitive's base string
//   forces `font-semibold` unconditionally, which would leak into the
//   unstyled role-text <p> (currently plain, inherited weight) and bold it -
//   an appearance change the variant/tone/size grid has no slot to prevent.
export default function Header() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  // #113 — respect the Settings unsaved-changes guard when jumping via this menu.
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const { data: org } = useOrganization();
  const unread = useUnreadCounts();
  const { isClockedIn } = useIsClockedIn();
  // Each shortcut is gated on the entitlement of the surface it jumps to, not on
  // one module-wide switch. Email is its own key (Starter+), so an org can own
  // the Inbox without `phone`; WhatsApp additionally needs a demo org, because
  // its route is wrapped in <DemoOnlyRoute> and bounces a real org to `/`.
  // Matches the sidebar locks in nav-registry and the route guards in App.tsx.
  const canAccessComm = useFeature('phone');
  const canAccessEmail = useFeature('email');
  const isDemoOrg = useIsDemoOrg();
  const canAccessWhatsApp = canAccessComm && isDemoOrg;
  // #2046 - the six shortcuts below (three inline `CommsButton`s + their three `OverflowItem`
  // kebab mirrors) all jump straight into the org-wide Communication SECTION, so each additionally
  // needs the section gate ANDed onto its per-channel entitlement. Deliberately NOT ANDed into
  // `canAccessComm` itself - `<GlobalDialer />` below keys on that alone and stays for every role
  // that may compose or dial, section gate or not.
  const ability = useAppAbility();
  const canSeeSection = ability.can('access_inbox', 'Communication');

  // Every page now carries its own titled header below the top bar, so the top
  // bar shows the organization name (branding/context) rather than a redundant
  // page title.
  const title = org?.name ?? '';
  const initials = user ? getInitials(`${user.first_name} ${user.last_name}`) : '';

  return (
    <div className="flex min-w-0 flex-1 items-center justify-between px-4 lg:px-6">
      {/* Left — page title (truncates so it never pushes the action cluster) */}
      {/* responsive breakpoint font size (text-lg, sm:text-xl) - no scale key expresses two
          sizes across breakpoints, and restoring the sm: escalation via className would be a
          dropped-typography-class restore, the exact layering-guard blind spot; left raw */}
      <h1 className="min-w-0 truncate text-lg font-semibold text-text-primary sm:text-xl">{title}</h1>

      {/* Center — Global Search */}
      <GlobalSearch
        className="min-w-0 flex-1 max-w-md mx-4 hidden md:block"
        placeholder="Search everything…"
      />

      {/* Right */}
      <div className="flex shrink-0 items-center gap-1">
        {/* Servy — the AI copilot launcher (replaces the old AI Center pill; AI
            Center now lives only in the left sidebar promo). Label collapses < lg. */}
        <CopilotLauncher />

        {/* Comms shortcuts + Help — inline on desktop. Below lg these
            collapse into the overflow (kebab) menu below to free up the bar. */}
        <div className="hidden items-center gap-1 lg:flex">
          <Separator orientation="vertical" className="mx-2 h-6" />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Help & support"
            title="Help & support"
          >
            <HelpCircle className="h-5 w-5" />
          </Button>
          {canAccessComm && canSeeSection && (
            <CommsButton
              icon={MessageSquare}
              count={unread.sms}
              label="Phone messages"
              onClick={() => requestLeave(() => navigate('/communication/phone'))}
            />
          )}
          {canAccessWhatsApp && canSeeSection && (
            <CommsButton
              icon={WhatsAppGlyph}
              iconClassName="text-whatsapp"
              count={unread.whatsapp}
              label="WhatsApp"
              onClick={() => requestLeave(() => navigate('/communication/whatsapp'))}
            />
          )}
          {canAccessEmail && canSeeSection && (
            <CommsButton
              icon={Mail}
              count={unread.email}
              label="Inbox"
              onClick={() => requestLeave(() => navigate('/communication/inbox'))}
            />
          )}
        </div>

        {/* Global dialer — click-to-call from any page (Emanuel's GlobalDialer).
            Demo orgs only; hidden for real orgs until telephony is live. */}
        {canAccessComm && <GlobalDialer />}

        {/* Overflow — comms + help as a kebab menu (< lg). */}
        <Popover>
          <PopoverTrigger asChild className="lg:hidden">
            <Button variant="ghost" size="icon" aria-label="More">
              <MoreVertical className="h-5 w-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-52 p-1">
            {canAccessComm && canSeeSection && (
              <OverflowItem
                icon={MessageSquare}
                label="Messages"
                count={unread.sms}
                onClick={() => requestLeave(() => navigate('/communication/phone'))}
              />
            )}
            {canAccessWhatsApp && canSeeSection && (
              <OverflowItem
                icon={WhatsAppGlyph}
                iconClassName="text-whatsapp"
                label="WhatsApp"
                count={unread.whatsapp}
                onClick={() => requestLeave(() => navigate('/communication/whatsapp'))}
              />
            )}
            {canAccessEmail && canSeeSection && (
              <OverflowItem
                icon={Mail}
                label="Inbox"
                count={unread.email}
                onClick={() => requestLeave(() => navigate('/communication/inbox'))}
              />
            )}
            <OverflowItem
              icon={HelpCircle}
              label="Help & support"
              onClick={() => {}}
            />
          </PopoverContent>
        </Popover>

        <Separator orientation="vertical" className="mx-2 hidden h-6 sm:block" />

        <NotificationBell />

        <Separator orientation="vertical" className="mx-2 hidden h-6 sm:block" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-background-light">
              <span className="relative">
                <Avatar className="h-9 w-9 ring-2 ring-primary-subtle">
                  <AvatarImage
                    src={org?.logo_url ?? undefined}
                    alt={org?.name ? `${org.name} logo` : 'Company logo'}
                    className="object-contain"
                  />
                  <AvatarFallback className="bg-primary-subtle text-sm font-semibold text-primary">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                {/* On-the-clock indicator — sage = "running/business state" */}
                {isClockedIn && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full bg-sage-500 ring-2 ring-surface-light"
                    aria-label="On the clock"
                  />
                )}
              </span>
              <div className="hidden text-left lg:block">
                <p className="text-sm font-medium leading-tight text-text-primary">
                  {user?.first_name} {user?.last_name}
                </p>
                <p className="text-xs leading-tight text-text-secondary">
                  {user?.role}
                </p>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="font-normal">
              <p className="text-sm font-medium">
                {user?.first_name} {user?.last_name}
              </p>
              <p className="text-xs text-text-secondary">{user?.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* Geofenced clock in/out — anchored to "me", not the crowded top bar */}
            <ClockInOutMenu />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => requestLeave(() => navigate('/settings/profile'))} className="cursor-pointer">
              <UserIcon className="mr-2 h-4 w-4" />
              My Profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => requestLeave(() => navigate('/settings/company'))} className="cursor-pointer">
              <SettingsIcon className="mr-2 h-4 w-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => logout()}
              className="text-danger focus:text-danger"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
