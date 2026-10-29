import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronDown, MoreHorizontal } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { cn } from '@/ui-kit/lib/utils';
import { useIsBelow, useMediaQuery, MEDIA } from '@/hooks/useIsMobile';
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen';
import { useRailMenuEntries, type RailMenuEntry } from './detailRailContext';

export interface DetailHeaderAction {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  variant?: 'destructive';
  /** Shown as a button beside the menu from sm up; below sm it joins the menu. */
  inline?: boolean;
  /** A separator is drawn before the first item of each new group. */
  group?: string;
  /** How the inline button looks from sm up (the page's own look); the menu item ignores it. */
  buttonVariant?: 'default' | 'outline' | 'destructive';
  buttonSize?: 'sm' | 'default';
  /** Extra classes for the inline button only. */
  buttonClassName?: string;
  /** Why it is disabled: shown on a tap or hover of the inline button (the kit Button's reason). */
  disabledReason?: string;
  /** False: from sm up it is an inline button, and below sm it is left out of the menu (the page's own menu items already carry it). */
  menuOnPhone?: boolean;
}

export interface DetailHeaderProps {
  /** Where Back goes when there is no in-app history to return to (the parent list). */
  backTo: string;
  backLabel: string;
  /** Title and record number. Must be able to shrink and truncate. */
  identity: ReactNode;
  /** Status chips and secondary meta; wraps. */
  meta?: ReactNode;
  /** The one primary action. Full width below sm. */
  primary?: ReactNode;
  /** On a phone the primary action lives in the bottom dock (`DetailDock`), not in the header. */
  primaryInDockOnPhone?: boolean;
  secondary: DetailHeaderAction[];
  /** Page-owned menu items (`DropdownMenuItem`s) rendered after `secondary`, on every width. */
  menuExtra?: ReactNode;
  /** Width class for the menu panel (default: the kit's). */
  menuContentClassName?: string;
  /** Called when the menu closes and would hand focus back to its trigger; preventDefault keeps focus where a follow-up popover opened. */
  onMenuCloseAutoFocus?: (event: Event) => void;
  /** The menu's name: its text on a phone, and from sm up (text, or the aria-label when icon-only). */
  menuLabel?: string;
  /** From sm up the menu is a "..." icon button named by `menuLabel`; a phone keeps the full-width labelled one. */
  menuIconOnly?: boolean;
  /** From sm up the primary action sits before the inline secondary actions (default: after them). */
  primaryFirst?: boolean;
  /** Keep the Back control from sm up too (default: a phone only; the wide layout has breadcrumbs). */
  backFromSm?: boolean;
  /**
   * `history` (default): back in the app's own history when there is some, else the parent.
   * `parent`: always the parent. For a page that is deep-linkable or replaces its own URL, where a
   * history pop lands somewhere arbitrary.
   */
  backMode?: 'history' | 'parent';
  /** Extra figure under the actions from sm up (right aligned), and under the meta on a phone. */
  aside?: ReactNode;
  className?: string;
}

/** True when the router has an earlier in-app entry to go back to. */
function hasInAppHistory(): boolean {
  const idx = (window.history.state as { idx?: number } | null)?.idx;
  return typeof idx === 'number' && idx > 0;
}

/**
 * The detail-page header (mobile slice 41, module 5). A page describes identity and actions; this
 * owns the stacking. Below sm: back + identity on one row, a wrapping meta row, the primary action
 * full width, and every secondary action inside one overflow menu. From sm up: inline actions
 * sit beside the menu and the rest stay in the menu.
 */
export function DetailHeader({
  backTo, backLabel, identity, meta, primary, primaryInDockOnPhone = false,
  secondary, menuExtra, menuContentClassName, onMenuCloseAutoFocus, menuLabel = 'Actions', menuIconOnly = false, primaryFirst = false,
  backFromSm = false, backMode = 'history', aside, className,
}: DetailHeaderProps) {
  const navigate = useNavigate();
  const phone = useIsBelow('sm');
  // Below md the side rail has no column, so its panels are listed in this menu (mobile slice 56).
  const railEntries = useRailMenuEntries();

  const inline = phone ? [] : secondary.filter((a) => a.inline);
  const menuItems = phone ? secondary.filter((a) => a.menuOnPhone !== false) : secondary.filter((a) => !a.inline);
  const showPrimary = primary && !(phone && primaryInDockOnPhone);
  const hasMenu = menuItems.length > 0 || Boolean(menuExtra) || railEntries.length > 0;
  const showBack = phone || backFromSm;

  const goBack = () => {
    if (backMode === 'history' && hasInAppHistory()) navigate(-1);
    else navigate(backTo);
  };

  const inlineButtons = inline.map((a) => (
    <Button
      key={a.key}
      variant={a.buttonVariant}
      size={a.buttonSize}
      className={a.buttonClassName}
      onClick={a.onSelect}
      disabled={a.disabled}
      disabledReason={a.disabledReason}
    >
      {a.icon} {a.label}
    </Button>
  ));

  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="detail-header">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="flex min-w-[min(100%,16rem)] flex-1 items-start gap-2">
          {showBack && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={backLabel}
              onClick={goBack}
              className="-ml-2 shrink-0"
            >
              <ArrowLeft />
            </Button>
          )}
          <div className="min-w-0 flex-1">{identity}</div>
        </div>

        {!phone && (
          <div className="ml-auto flex max-w-full flex-col items-end gap-3">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {primaryFirst && showPrimary && primary}
              {inlineButtons}
              {!primaryFirst && showPrimary && primary}
              {hasMenu && (
                <ActionsMenu label={menuLabel} items={menuItems} extra={menuExtra} railEntries={railEntries} contentClassName={menuContentClassName} onCloseAutoFocus={onMenuCloseAutoFocus} iconOnly={menuIconOnly} />
              )}
            </div>
            {aside}
          </div>
        )}
      </div>

      {meta && <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{meta}</div>}

      {phone && aside}

      {phone && (
        <div className="flex flex-col gap-2">
          {showPrimary && (
            <div className="flex flex-col gap-2 [&>*]:w-full [&>[data-disabled-reason-shell]]:flex [&>[data-disabled-reason-shell]>button]:h-11 [&>[data-disabled-reason-shell]>button]:w-full [&>button]:h-11">
              {primary}
            </div>
          )}
          {hasMenu && <ActionsMenu label={menuLabel} items={menuItems} extra={menuExtra} railEntries={railEntries} contentClassName={menuContentClassName} onCloseAutoFocus={onMenuCloseAutoFocus} fullWidth />}
        </div>
      )}
    </div>
  );
}

function ActionsMenu({
  label, items, extra, railEntries, contentClassName, onCloseAutoFocus, fullWidth, iconOnly,
}: {
  label: string; items: DetailHeaderAction[]; extra?: ReactNode; railEntries: readonly RailMenuEntry[]; contentClassName?: string;
  onCloseAutoFocus?: (event: Event) => void; fullWidth?: boolean; iconOnly?: boolean;
}) {
  const icon = iconOnly && !fullWidth;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {icon ? (
          <Button variant="outline" size="icon-sm" aria-label={label} data-slot="detail-actions-trigger">
            <MoreHorizontal />
          </Button>
        ) : (
          // No aria-label: the accessible name is the visible text.
          <Button variant="outline" className={fullWidth ? 'h-11 w-full' : undefined} data-slot="detail-actions-trigger">
            {label} <ChevronDown />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={contentClassName} onCloseAutoFocus={onCloseAutoFocus}>
        {items.map((a, i) => (
          <div key={a.key}>
            {i > 0 && a.group !== items[i - 1]?.group && <DropdownMenuSeparator />}
            <DropdownMenuItem variant={a.variant} onClick={a.onSelect} disabled={a.disabled}>
              {a.icon}
              {a.disabled && a.disabledReason ? (
                // Visible, not only a title: a touch screen never shows a title (mobile slice 40).
                <span className="flex flex-col">
                  <span>{a.label}</span>
                  <span className="text-muted-foreground whitespace-normal text-xs font-normal">{a.disabledReason}</span>
                </span>
              ) : (
                a.label
              )}
            </DropdownMenuItem>
          </div>
        ))}
        {extra}
        {railEntries.length > 0 && (items.length > 0 || extra) && <DropdownMenuSeparator />}
        {railEntries.map((entry) => (
          <DropdownMenuItem key={entry.key} onClick={entry.open}>
            {entry.icon}
            {entry.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The phone-only bottom dock: the page's primary action in the thumb zone. Sticks to the bottom of
 * the page scroller (render it as the LAST child of the page's content), and gone while the keyboard
 * is open. It needs no home-indicator padding of its own: the shell frame already ends above the
 * indicator (shell.css `.shell`, mobile slice 52), so padding here would stack a second inset. Renders nothing at sm and up.
 */
export function DetailDock({ children }: { children: ReactNode }) {
  const phone = useIsBelow('sm');
  const keyboardOpen = useKeyboardOpen();
  // A phone held sideways has no height to give a pinned bar (the gate's chrome ratio: at most a fifth
  // of the screen): there the dock is the last row of the page instead, one scroll away.
  const short = useMediaQuery(MEDIA.shortHeight);
  if (!phone || keyboardOpen || !children) return null;
  return (
    <div
      data-testid="detail-dock"
      className={cn(
        'bg-kit-card border-border z-20 -mx-4 -mb-4 border-t px-4 py-2 [&>button]:h-11 [&>button]:w-full',
        !short && 'sticky bottom-0',
      )}
    >
      {children}
    </div>
  );
}
