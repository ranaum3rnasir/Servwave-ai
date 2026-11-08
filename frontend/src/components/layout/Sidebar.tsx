import { useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { ChevronDown, GripVertical, Plus, X, Sparkles, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { cn } from '@/lib/utils';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { quickCreateItems } from './nav-config';
import {
  getDestination, isDemoDestUnlockedForOrg, hasNavFeature, isNavChildLocked,
  resolveNavHref, visibleNavChildren, type NavAccess, type NavDestination,
} from './nav-registry';
import { useNavLayout } from './useNavLayout';
import SidebarAddShortcut from './SidebarAddShortcut';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useAuthStore } from '@/stores/auth.store';
import { useOrgFeatures, useEntitlementsReady, requiredPlanFor, PLAN_LABELS } from '@/lib/entitlements';

interface SidebarProps {
  collapsed: boolean;
}

export default function Sidebar({ collapsed }: SidebarProps) {
  const ability = useAppAbility();
  const openAiCenter = useAiCenterStore((s) => s.openModal);
  const isDemoOrg = useIsDemoOrg();
  const orgId = useAuthStore((s) => s.user?.organization_id);
  const orgFeatures = useOrgFeatures();
  const entitlementsReady = useEntitlementsReady();
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const location = useLocation();
  const { keys, move, add, remove } = useNavLayout();
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Explicit open/closed overrides per group key. Undefined = auto (open when a
  // child route is active).
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});

  // The single access context every nav surface reasons with (shared with
  // V2AppLayout via nav-registry) - CASL + entitlements + demo flag.
  const access: NavAccess = {
    can: (action, subject) => ability.can(action, subject),
    orgFeatures,
    entitlementsReady,
    isDemoOrg,
  };

  // Resolve keys → destinations, then CASL-filter to what the user may access.
  const items = keys
    .map((key) => ({ key, dest: getDestination(key) }))
    .filter(
      (x): x is { key: string; dest: NavDestination } =>
        !!x.dest && ability.can(x.dest.action, x.dest.subject)
    );

  function onDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return;
    // Map filtered indices back to absolute indices in `keys`.
    const fromKey = items[dragIndex]?.key;
    const toKey = items[targetIndex]?.key;
    if (!fromKey || !toKey) return;
    move(keys.indexOf(fromKey), keys.indexOf(toKey));
    setDragIndex(null);
  }

  // "Coming soon" marker for modules whose backend integration is still pending
  // (Communication: Phone / WhatsApp / Inbox — see Track-2 plans C/W/G).
  // A wordless amber clock, NOT a text pill: a pill steals label width in the
  // 240px rail and truncated "Communication". Icon + amber color + sr-only text
  // keep it WCAG-safe (not color-alone); the native title tooltip spells it out.
  function renderComingSoonBadge() {
    return (
      <span
        title="Coming soon — backend integration pending"
        className="inline-flex shrink-0 items-center text-warning/90"
      >
        <Clock className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">Coming soon</span>
      </span>
    );
  }

  // Plan-locked rows badge the tier that unlocks them ("Pro" / "Scale"), which
  // is a different message from the amber "coming soon" clock. Falls back to
  // the clock for demo-only rows (Marketing), which have no feature key.
  function renderPlanBadge(feature?: string | string[]) {
    const label = PLAN_LABELS[requiredPlanFor(feature) ?? ''];
    if (!label) return renderComingSoonBadge();
    return (
      <span
        title={`Not available on your plan — requires ${label}`}
        className="shrink-0 rounded-full bg-on-fill/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-on-fill/70"
      >
        {label}
      </span>
    );
  }

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-ocean-900 bg-gradient-to-b from-ocean-900 to-ocean-800 transition-all duration-200',
        collapsed ? 'w-16' : 'w-sidebar'
      )}
    >
      {/* Quick Create */}
      <div className={cn('px-3 pt-4 pb-2', collapsed && 'flex justify-center')}>
        <DropdownMenu>
          {/* Both raw buttons below are the asChild target of this DropdownMenuTrigger
              (the collapsed branch nests a second asChild TooltipTrigger on top) -
              never-convert per the UI component architecture program: Radix clones
              its trigger props onto whichever single element renders here, and this
              exact ternary is the flagged double/asChild-nested trigger shape. */}
          <DropdownMenuTrigger asChild>
            {collapsed ? (
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <button className="flex h-9 w-9 items-center justify-center rounded-button border-2 border-on-fill bg-on-fill text-primary transition-colors duration-200 hover:bg-primary-subtle">
                    <Plus className="h-5 w-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">Create new</TooltipContent>
              </Tooltip>
            ) : (
              <button className="flex w-full items-center gap-2 rounded-button border-2 border-on-fill bg-on-fill py-3 pl-4 pr-5 text-sm font-semibold text-primary transition-colors duration-200 hover:bg-primary-subtle">
                <Plus className="h-4 w-4" />
                Create New
              </button>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-48">
            {quickCreateItems
              .filter((item) => ability.can(item.action, item.subject))
              .map((item) => (
                <DropdownMenuItem
                  key={item.href}
                  onClick={() => requestLeave(() => navigate(item.href))}
                  className="gap-2 cursor-pointer"
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Customize toggle (hidden when collapsed) */}
      {!collapsed && (
        <div className="flex items-center justify-between px-4 pb-1 pt-1">
          <span className="text-xs font-semibold uppercase tracking-widest text-on-fill/45">
            Sidebar
          </span>
          {/* Raw by design: a translucent-pill state toggle (rounded-full,
              bg-on-fill/10 idle -> /20 hover) with no matching cell in the Button
              grid - no minted variant/tone carries an idle fill this faint on a
              dark surface, and inventing one is out of scope here. */}
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="rounded-full bg-on-fill/10 px-2.5 py-1 text-xs font-medium text-on-fill transition-colors hover:bg-on-fill/20"
          >
            {editing ? '✓ Done' : '✎ Customize'}
          </button>
        </div>
      )}

      {/* Navigation — flat, per-user customizable shortcut list */}
      <nav className="flex-1 overflow-x-hidden overflow-y-auto px-3 py-2">
        <div className="space-y-1">
          {items.map(({ key, dest }, index) => {
            const Icon = dest.icon;
            // Locked for real orgs on either axis: a plan entitlement the org
            // lacks (featureLocked), or a demo-only surface (demoLocked) —
            // render a non-clickable row instead of a live NavLink. The route
            // itself is blocked by <RequireFeature>/<DemoOnlyRoute>, so this is
            // the visual half of the gate. featureLocked is gated on
            // entitlementsReady so a stale cached payload does not grey out
            // every module on first paint — same reasoning as useFeature
            // failing open.
            const featureLocked = !hasNavFeature(dest.feature, access);
            const demoLocked =
              !!dest.demoOnly && !isDemoOrg && !isDemoDestUnlockedForOrg(dest, orgId);
            const locked = featureLocked || demoLocked;
            // A group lands on its first REACHABLE child, not its declared href -
            // `/communication/phone` is a dead link for an email-only org.
            const href = resolveNavHref(dest, access);

            // Expandable group: click toggles open/closed (no navigation).
            // Children render inline. Skipped while collapsed or editing so the
            // rail stays compact and the reorder list stays flat. Also skipped
            // when locked (demo-only, real org): a locked group must render as
            // the greyed, non-clickable "coming soon" row below, not an
            // expandable list of live child links.
            const childItems = visibleNavChildren(dest, access);
            if (childItems.length > 0 && !collapsed && !editing && !locked) {
              const hasActiveChild = childItems.some(
                (c) =>
                  location.pathname === c.href ||
                  location.pathname.startsWith(c.href + '/')
              );
              const open = groupOpen[key] ?? hasActiveChild;
              return (
                <div key={key}>
                  {/* Raw by design: an expandable nav-group header row (icon + label +
                      chevron, active-child state driven by a conditional inset-shadow
                      class the Button primitive has no slot for) - a list-row/disclosure
                      control, not a Button. */}
                  <button
                    type="button"
                    onClick={() => setGroupOpen((g) => ({ ...g, [key]: !open }))}
                    aria-expanded={open}
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${dest.label}${
                      dest.comingSoon ? ', coming soon' : ''
                    }`}
                    title={
                      dest.comingSoon ? 'Coming soon — backend integration pending' : undefined
                    }
                    className={cn(
                      'group flex w-full gap-3 rounded-lg px-4 py-2.5 text-sm font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-on-fill/40',
                      // Coming-soon groups stack a caption under the label, so the
                      // row aligns to the top instead of centering a single line.
                      dest.comingSoon ? 'items-start' : 'items-center',
                      hasActiveChild
                        ? 'bg-on-fill/10 text-on-fill font-semibold shadow-[inset_3px_0_0_0_rgb(var(--text-on-fill))]'
                        : 'text-on-fill/70 hover:bg-on-fill/10 hover:text-on-fill'
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-5 w-5 shrink-0',
                        dest.comingSoon && 'mt-0.5',
                        hasActiveChild && 'text-on-fill'
                      )}
                    />
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate">{dest.label}</span>
                      {dest.comingSoon && (
                        <span className="mt-0.5 block text-[11px] font-semibold leading-none text-warning/90">
                          Coming soon
                        </span>
                      )}
                    </span>
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 transition',
                        dest.comingSoon && 'mt-0.5',
                        !open && '-rotate-90'
                      )}
                    />
                  </button>
                  <Collapse open={open} className="ml-3 mt-0.5">
                    <ul className="space-y-0.5 border-l border-on-fill/15 pl-2">
                      {childItems.map((c) => {
                        // A child whose href prefixes a sibling (e.g. Stock `/inventory`
                        // vs `/inventory/price-book`) must match EXACTLY — otherwise
                        // NavLink keeps it highlighted on every sub-route.
                        const exact =
                          c.href === '/' ||
                          childItems.some(
                            (s) => s.href !== c.href && s.href.startsWith(c.href + '/')
                          );
                        // Demo-only child in a real org: LOCKED, not hidden -
                        // same treatment as a locked top-level row (greyed,
                        // aria-disabled, coming-soon badge), one size down to
                        // match the child type scale. Hiding it would leave a
                        // live-looking route reachable by URL with nothing in
                        // the nav admitting it exists.
                        if (isNavChildLocked(c, access)) {
                          return (
                            <li key={c.key}>
                              <div
                                aria-disabled="true"
                                title="Coming soon - not available on your plan yet"
                                className="flex w-full cursor-not-allowed select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-on-fill/40"
                              >
                                <c.icon className="h-3.5 w-3.5 shrink-0" />
                                <span className="min-w-0 flex-1 truncate text-left">{c.label}</span>
                                {renderComingSoonBadge()}
                              </div>
                            </li>
                          );
                        }
                        return (
                          <li key={c.key}>
                            <NavLink
                              to={c.href}
                              end={exact}
                              onClick={(e) => {
                                if (useSettingsGuard.getState().isDirty) {
                                  e.preventDefault();
                                  requestLeave(() => navigate(c.href));
                                }
                              }}
                              className={({ isActive }) =>
                                cn(
                                  'group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                                  isActive
                                    ? 'bg-on-fill/10 text-on-fill font-semibold shadow-[inset_3px_0_0_0_rgb(var(--text-on-fill))]'
                                    : 'text-on-fill/65 hover:bg-on-fill/10 hover:text-on-fill'
                                )
                              }
                            >
                              {({ isActive }) => (
                                <>
                                  <c.icon
                                    className={cn('h-3.5 w-3.5 shrink-0', isActive && 'text-on-fill')}
                                  />
                                  <span className="min-w-0 flex-1 truncate text-left">
                                    {c.label}
                                  </span>
                                  {c.comingSoon && renderComingSoonBadge()}
                                </>
                              )}
                            </NavLink>
                          </li>
                        );
                      })}
                    </ul>
                  </Collapse>
                </div>
              );
            }

            const row = (
              <div
                draggable={editing && !collapsed}
                onDragStart={() => setDragIndex(index)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDrop(index)}
                className={cn(
                  'group flex items-center rounded-lg',
                  editing && !collapsed && 'border border-dashed border-on-fill/30'
                )}
              >
                {editing && !collapsed && (
                  <GripVertical className="ml-1 h-4 w-4 shrink-0 cursor-grab text-on-fill/40" />
                )}
                {locked ? (
                  <div
                    aria-disabled="true"
                    title={
                      dest.feature
                        ? 'Not available on your plan'
                        : 'Coming soon — not available on your plan yet'
                    }
                    className={cn(
                      'flex min-w-0 flex-1 cursor-not-allowed select-none items-center rounded-lg py-2.5 text-sm font-medium text-on-fill/40',
                      collapsed ? 'justify-center px-0' : 'gap-3 px-4'
                    )}
                  >
                    <Icon className="h-5 w-5 shrink-0" />
                    {!collapsed && (
                      <span className="min-w-0 flex-1 truncate text-left">{dest.label}</span>
                    )}
                    {!collapsed && renderPlanBadge(dest.feature)}
                  </div>
                ) : (
                  <NavLink
                    to={href}
                    end={href === '/'}
                    onClick={(e) => {
                      if (useSettingsGuard.getState().isDirty) {
                        e.preventDefault();
                        requestLeave(() => navigate(href));
                      }
                    }}
                    className={({ isActive }) =>
                      cn(
                        'flex min-w-0 flex-1 items-center rounded-lg py-2.5 text-sm font-medium transition-colors duration-200',
                        collapsed ? 'justify-center px-0' : 'gap-3 px-4',
                        isActive
                          ? 'bg-on-fill/10 text-on-fill font-semibold shadow-[inset_3px_0_0_0_rgb(var(--text-on-fill))]'
                          : 'text-on-fill/70 hover:bg-on-fill/10 hover:text-on-fill'
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <Icon className={cn('h-5 w-5 shrink-0', isActive && 'text-on-fill')} />
                        {!collapsed && (
                          <span className="min-w-0 flex-1 truncate text-left">{dest.label}</span>
                        )}
                        {!collapsed && dest.comingSoon && renderComingSoonBadge()}
                      </>
                    )}
                  </NavLink>
                )}
                {editing && !collapsed && (
                  // Raw by design: a small inline remove/close-X affordance on an
                  // editable nav row (the chip/toast-dismiss shape) - not a Button.
                  <button
                    type="button"
                    aria-label={`Remove ${dest.label}`}
                    onClick={() => remove(key)}
                    className="mr-1 shrink-0 text-danger/80 hover:text-danger"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            );

            if (collapsed) {
              return (
                <Tooltip key={key} delayDuration={0}>
                  <TooltipTrigger asChild>
                    <div>{row}</div>
                  </TooltipTrigger>
                  <TooltipContent side="right">{dest.label}</TooltipContent>
                </Tooltip>
              );
            }
            return <div key={key}>{row}</div>;
          })}
        </div>

        {editing && !collapsed && (
          // Raw by design: the dashed-border "add" affordance has no minted cell -
          // the Button grid has no dashed-border treatment at any tone, and forcing
          // it onto a solid/outline/ghost structure would invent a new look.
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-on-fill/30 bg-on-fill/[0.04] py-2 text-sm font-medium text-on-fill/80 transition-colors hover:bg-on-fill/10 hover:text-on-fill"
          >
            <Plus className="h-4 w-4" /> Add shortcut
          </button>
        )}
      </nav>

      {/* AI Agentic Farm launcher — compact, pinned at the bottom */}
      {ability.can('read', 'AiCenter') && (
        <div className={cn('border-t border-on-fill/10 px-3 py-2', collapsed && 'flex justify-center')}>
          {collapsed ? (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="onDark"
                  size="icon"
                  aria-label="AI Agentic Farm"
                  onClick={() => openAiCenter()}
                  className="h-9 w-9"
                >
                  <Sparkles className="h-5 w-5 shrink-0 text-ai-200" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">AI Agentic Farm</TooltipContent>
            </Tooltip>
          ) : (
            // Raw by design: full-width nav-row treatment identical to the NavLink
            // items above it (same idle and hover colours, same corner radius and
            // padding) - a list-row, not a Button; converting it would either
            // mismatch its sibling rows' corner radius (tailwind-merge has no
            // conflict group for the custom rounded-button key, so a className
            // override isn't reliable) or fight the primitive's own rounded-button
            // shape.
            <button
              type="button"
              onClick={() => openAiCenter()}
              className="group flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium text-on-fill/70 transition-colors duration-200 hover:bg-on-fill/10 hover:text-on-fill"
            >
              <Sparkles className="h-5 w-5 shrink-0 text-ai-200" />
              <span className="min-w-0 flex-1 truncate text-left">AI Agentic Farm</span>
            </button>
          )}
        </div>
      )}

      {/* Settings & Admin gear retired — Settings now lives in the top-right user menu (Header). */}

      <SidebarAddShortcut
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        current={keys}
        onAdd={(key) => add(key)}
      />
    </aside>
  );
}
