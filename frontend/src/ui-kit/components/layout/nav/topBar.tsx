"use client";

import * as React from "react";
import { MoreHorizontal, PanelLeftOpen, Search } from "lucide-react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/ui-kit/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui-kit/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/ui-kit/components/ui/dropdownMenu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/ui-kit/components/ui/sheet";
import { useSidebar } from "@/ui-kit/components/layout/appShell";
import { fieldKindProps } from "@/ui-kit/lib/fieldKind";

/**
 * Application bar.
 *
 * Full width, transparent, and OUTSIDE the canvas. It is app chrome, not part
 * of the page: nothing in it may move because the navigation panel underneath
 * it changed width, which is exactly what happens the moment it is nested in a
 * column beside the sidebar. Transparent rather than filled for the same reason
 * the sidebar is - one rounded canvas floating on a flat surface, no hairlines
 * crossing at the corners.
 *
 * Layout, left to right: brand (fixed), search (`margin-left:auto`, capped at
 * 320px), actions. The gap left of the search field is deliberate and reserved
 * for a workspace or company name.
 */
export interface TopBarProps extends React.ComponentProps<"header"> {
  /**
   * A status that rides on the drawer trigger as a dot (the app passes "On the clock" while the
   * user is clocked in), so the state is glanceable with the drawer shut. The text is the dot's
   * accessible description; the dot alone would be colour-only.
   */
  drawerStatus?: string;
}

function TopBar({ className, children, drawerStatus, ...props }: TopBarProps) {
  const { isDrawer, toggle } = useSidebar();
  const statusId = React.useId();
  return (
    <header data-slot="topbar" className={cn("topbar", className)} {...props}>
      {/* Desktop has no opener here - collapsing lives on the sidebar itself,
          inline with its first group heading. A drawer needs one, because it is
          not on screen: phones, and landscape phones (wide but short). */}
      {isDrawer && (
        <TopBarAction
          label="Open navigation"
          data-slot="topbar-nav-trigger"
          aria-describedby={drawerStatus ? statusId : undefined}
          onClick={toggle}
        >
          <PanelLeftOpen />
          {drawerStatus && (
            <>
              <span aria-hidden data-slot="topbar-nav-status" className="nav-status-dot" />
              <span id={statusId} className="sr-only">{drawerStatus}</span>
            </>
          )}
        </TopBarAction>
      )}
      {children}
    </header>
  );
}

export interface TopBarBrandProps extends React.ComponentProps<"div"> {
  /** The glyph inside the rounded brand mark. */
  mark?: React.ReactNode;
  /** The wordmark. A prop, not children: under asChild children is the link. */
  label: string;
  /** Merge onto the caller's element (a router link), rather than a div. */
  asChild?: boolean;
}

/**
 * Logo plus wordmark. Fixed: it never reacts to the sidebar, so the brand keeps
 * one position on screen no matter what the nav is doing.
 */
function TopBarBrand({ className, mark, label, asChild, children, ...props }: TopBarBrandProps) {
  const Comp = asChild ? Slot : "div";

  const content = (
    <>
      {mark && <span className="brand-mark">{mark}</span>}
      <span className="brand-word">{label}</span>
    </>
  );

  // Same rule as SidebarItem: Slot takes exactly one element child, so under
  // asChild the caller's element is that child and the brand content is cloned
  // into it.
  const body =
    asChild && React.isValidElement(children)
      ? React.cloneElement(
          children as React.ReactElement<{ children?: React.ReactNode }>,
          undefined,
          content,
        )
      : content;

  return (
    <Comp data-slot="topbar-brand" className={cn("tb-brand", className)} {...props}>
      {body}
    </Comp>
  );
}

export interface TopBarWorkspaceProps extends React.ComponentProps<"div"> {
  /** The organisation the signed-in user is currently working in. */
  name: string;
}

/**
 * The organisation's name, in the gap `TopBar` reserves for it between the
 * brand and the search field.
 *
 * The brand says which product this is; without this the bar never says which
 * organisation you are signed in to, which is the one thing a multi-tenant app
 * cannot leave to inference. A hairline separates the two so "ServWave" and the
 * company name do not read as one long wordmark.
 *
 * The caller decides whether there is a name to show at all - this renders what
 * it is given rather than an empty slot, so a bar with no organisation loaded
 * keeps the brand hard against the search field instead of holding a gap open
 * for text that never arrives.
 */
function TopBarWorkspace({ className, name, ...props }: TopBarWorkspaceProps) {
  return (
    <div data-slot="topbar-workspace" className={cn("tb-workspace", className)} {...props}>
      <span aria-hidden className="tb-div" />
      <span className="tb-workspace-name">{name}</span>
    </div>
  );
}

export interface TopBarSearchProps extends React.ComponentProps<"input"> {
  shortcut?: string;
}

function TopBarSearch({ className, shortcut = "⌘K", ...props }: TopBarSearchProps) {
  return (
    <div data-slot="topbar-search" className={cn("tb-search", className)}>
      <Search />
      {/* Filled, unbordered until focus: a bordered field in a transparent
          chrome bar competes with the panel borders below it. */}
      <input {...fieldKindProps('search')} aria-label="Search" {...props} />
      {shortcut && <kbd className="tb-kbd">{shortcut}</kbd>}
    </div>
  );
}

function TopBarActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="topbar-actions" className={cn("tb-actions", className)} {...props} />;
}

export interface TopBarActionProps extends React.ComponentProps<"button"> {
  /** Accessible name and tooltip text. The icon carries no label of its own. */
  label: string;
  /** Count bubble. Rendered as-is, so "99+" works. */
  badge?: string | number;
}

/** One icon button in the action row, with its optional count bubble. */
function TopBarAction({ className, label, badge, children, ...props }: TopBarActionProps) {
  const button = (
    <button
      type="button"
      data-slot="topbar-action"
      aria-label={label}
      className={cn("tb-icon", className)}
      {...props}
    >
      {children}
      {badge != null && <TopBarBadge>{badge}</TopBarBadge>}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Count bubble for an icon button. The card-coloured ring cuts it out of the icon. */
function TopBarBadge({ className, children, ...props }: React.ComponentProps<"span">) {
  const wide = String(children).length > 2;
  return (
    <span
      data-slot="topbar-badge"
      className={cn("notif", wide && "is-wide", className)}
      {...props}
    >
      {children}
    </span>
  );
}

/** Hairline between groups of actions. */
function TopBarDivider({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="topbar-divider" aria-hidden className={cn("tb-div", className)} {...props} />;
}

/**
 * The one action in the bar that opens a surface rather than a menu, so it gets
 * a labelled pill instead of another anonymous glyph.
 */
function TopBarPill({ className, children, ...props }: React.ComponentProps<"button">) {
  return (
    <button type="button" data-slot="topbar-pill" className={cn("tb-pill", className)} {...props}>
      {children}
    </button>
  );
}

export interface TopBarUserProps extends React.ComponentProps<"button"> {
  name: string;
  role?: string;
  /** Background for the initials chip. Comes from the kit's avatar tint scale. */
  tint?: string;
  initials: string;
  /**
   * Organisation logo, shown INSTEAD of the initials chip.
   *
   * The chip is the app's one piece of tenant branding, so a company that has
   * uploaded a logo gets it here rather than a generated tint. Falls back to
   * the initials when there is no logo and, like the kit's Avatar, when the
   * image fails to load - a broken-image glyph in the top bar is worse than
   * the chip it replaced.
   */
  avatarSrc?: string;
  /** Alternative text for `avatarSrc`. Required with it, so the logo is named. */
  avatarAlt?: string;
}

function TopBarUser({
  className, name, role, tint, initials, avatarSrc, avatarAlt, ...props
}: TopBarUserProps) {
  const [failed, setFailed] = React.useState(false);
  const showLogo = Boolean(avatarSrc) && !failed;

  return (
    <button type="button" data-slot="topbar-user" className={cn("tb-user", className)} {...props}>
      {/* aria-hidden only while it is a chip of initials, which merely repeats
          the name beside it. A logo carries its own alt text and is the org's
          identity, not a decoration, so it stays in the accessibility tree. */}
      <span
        className="tb-avatar"
        style={showLogo ? undefined : { backgroundColor: tint }}
        aria-hidden={showLogo ? undefined : true}
      >
        {showLogo ? (
          <img src={avatarSrc} alt={avatarAlt ?? ""} onError={() => setFailed(true)} />
        ) : (
          initials
        )}
      </span>
      <span className="tb-user-meta">
        <span className="tb-user-name">{name}</span>
        {role && <span className="tb-user-role">{role}</span>}
      </span>
    </button>
  );
}

// ---- the phone top bar ------------------------------------------------------
//
// Below md (the same `useSidebar().isMobile` that turns the sidebar into a
// drawer, so the two can never disagree) a row of seven icons, a pill and an
// account chip ran to x=605 on a 320 px phone. The layout does not decide what
// gives way: it hands the shell DESCRIPTORS, and the shell decides. Wide, every
// item renders exactly as it did before. Below md, pinned items stay in the bar
// and everything else moves into ONE overflow menu at the end of the row.

/** An action: a tap that does one thing. */
export interface TopBarActionItem {
  id: string;
  /** Accessible name, tooltip, and the overflow menu's row text. */
  label: string;
  icon: React.ReactNode;
  /** Count bubble; travels with the action into the overflow menu. */
  badge?: string | number;
  onSelect?: () => void;
  /** A link instead of a handler (a `mailto:`), so the browser handles it natively. */
  href?: string;
  /**
   * Its own control in the wide bar, when it already has one (the dialer's
   * trigger). Without it the wide bar renders a plain `TopBarAction`.
   */
  inline?: React.ReactNode;
  /**
   * `"compact"`: offered only in the phone overflow menu. For an entry the
   * wide bar never had, so adding it to the phone menu leaves desktop unchanged.
   */
  only?: "compact";
}

/** A menu: the wide bar shows its trigger; below md its items become a section of the overflow menu. */
export interface TopBarMenuItem {
  id: string;
  label: string;
  /** The wide bar's trigger, rendered `asChild` under the menu trigger. */
  trigger: React.ReactElement;
  /** DropdownMenu content (items, labels, separators). */
  menu: React.ReactNode;
  menuClassName?: string;
  /**
   * Below md the menu's items are normally folded into the overflow menu. Set this when something
   * else carries them on a phone (the navigation drawer's account block), so they are not offered
   * twice.
   */
  wideOnly?: boolean;
}

/** Always in the bar, at every width (Notifications, which owns its own badge and sheet). */
export interface TopBarPinnedItem {
  id: string;
  pinned: React.ReactNode;
}

/** A hairline between groups. Wide bar only. */
export interface TopBarDividerItem {
  id: string;
  divider: true;
}

export type TopBarItem = TopBarActionItem | TopBarMenuItem | TopBarPinnedItem | TopBarDividerItem;

const isDivider = (i: TopBarItem): i is TopBarDividerItem => "divider" in i;
const isPinned = (i: TopBarItem): i is TopBarPinnedItem => "pinned" in i;
const isMenu = (i: TopBarItem): i is TopBarMenuItem => "menu" in i;
const hasBadge = (b: TopBarActionItem["badge"]) => b != null && b !== "" && b !== 0;

export interface TopBarItemsProps {
  items: TopBarItem[];
  /** The overflow button's name. */
  moreLabel?: string;
}

/**
 * The bar's actions, laid out by the shell. See the block comment above.
 *
 * Wide: each item in order, as its own control (a plain `TopBarAction`, the
 * item's own `inline` control, a menu behind its `trigger`, or the pinned node).
 * Below md: pinned items in order, then one "More" button holding every action
 * (badges carried along) and, after a separator, every menu's items.
 */
function TopBarItems({ items, moreLabel = "More" }: TopBarItemsProps) {
  const { isMobile } = useSidebar();

  if (!isMobile) {
    return (
      <>
        {items.map((item) => {
          if (isDivider(item)) return <TopBarDivider key={item.id} />;
          if (isPinned(item)) return <React.Fragment key={item.id}>{item.pinned}</React.Fragment>;
          if (isMenu(item)) {
            return (
              <DropdownMenu key={item.id}>
                <DropdownMenuTrigger asChild>{item.trigger}</DropdownMenuTrigger>
                <DropdownMenuContent align="end" className={item.menuClassName}>
                  {item.menu}
                </DropdownMenuContent>
              </DropdownMenu>
            );
          }
          if (item.only === "compact") return null;
          if (item.inline) return <React.Fragment key={item.id}>{item.inline}</React.Fragment>;
          return (
            <TopBarAction key={item.id} label={item.label} badge={item.badge} onClick={item.onSelect}>
              {item.icon}
            </TopBarAction>
          );
        })}
      </>
    );
  }

  const pinned = items.filter(isPinned);
  const actions = items.filter((i): i is TopBarActionItem => !isDivider(i) && !isPinned(i) && !isMenu(i));
  const menus = items.filter(isMenu).filter((m) => !m.wideOnly);
  const unread = actions.some((a) => hasBadge(a.badge));

  return (
    <>
      {pinned.map((item) => (
        <React.Fragment key={item.id}>{item.pinned}</React.Fragment>
      ))}
      {(actions.length > 0 || menus.length > 0) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TopBarAction label={unread ? `${moreLabel}, unread inside` : moreLabel} data-slot="topbar-more">
              <MoreHorizontal />
              {unread && <span aria-hidden data-slot="topbar-badge" className="notif is-dot" />}
            </TopBarAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {actions.map((a) => {
              const body = (
                <>
                  {a.icon}
                  <span className="min-w-0 flex-1 truncate">{a.label}</span>
                  {hasBadge(a.badge) && (
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-notify px-1 text-[10px] leading-none font-semibold text-on-fill">
                      {a.badge}
                      <span className="sr-only"> unread</span>
                    </span>
                  )}
                </>
              );
              return a.href ? (
                <DropdownMenuItem key={a.id} asChild>
                  <a href={a.href}>{body}</a>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={a.id} onSelect={a.onSelect}>
                  {body}
                </DropdownMenuItem>
              );
            })}
            {menus.map((m) => (
              <React.Fragment key={m.id}>
                {actions.length > 0 && <DropdownMenuSeparator />}
                {m.menu}
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

export interface TopBarSearchSlotProps {
  /** The search button's name below md, and the search panel's. */
  label?: string;
  /**
   * The search control itself (the app's search, with its results list): ONE
   * element that takes a `className`, which the wide bar merges the slot's
   * layout class onto.
   */
  children: React.ReactElement<{ className?: string; presentation?: "popover" | "sheet" }>;
  /** Any change closes the phone search panel (pass the route, so picking a result closes it). */
  resetKey?: unknown;
}

/**
 * Where the search field goes. Wide: inline, pushed right against the actions
 * and capped at 320 px, exactly where the field always sat. Below md the field
 * gives its width to the row and a search button opens it in a panel the width
 * of the screen, under the bar.
 */
function TopBarSearchSlot({ label = "Search", children, resetKey }: TopBarSearchSlotProps) {
  const { isMobile } = useSidebar();
  const [open, setOpen] = React.useState(false);
  // Close on a new route: adjust state during render (React's documented
  // pattern) rather than in an effect, which would paint the open panel over
  // the new page for a frame first.
  const [seenKey, setSeenKey] = React.useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    if (open) setOpen(false);
  }

  if (!isMobile) {
    // The layout class goes ON the field's own root (Slot), not on a wrapper
    // around it: the field is then the bar's flex item exactly as it always
    // was. Wrapped, WebKit kept the results list's rows at their pre-scrollbar
    // width once the list grew a scrollbar (iPad project: rows 179px in a
    // 168px list), and the list scrolled sideways.
    return <Slot className="tb-search-slot">{children}</Slot>;
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <TopBarAction label={label} data-slot="topbar-search-button" className="tb-search-button">
          <Search />
        </TopBarAction>
      </SheetTrigger>
      {/* Full screen (mobile slice 33): a modal over the whole viewport, so the field has the
          screen's width, the keyboard has the screen's height to share with the results, and the
          sheet sits over the copilot pill instead of under it. The title is the dialog's name. The top
          and side insets come from the sheet's own transparent borders (sheetVariants "top"): the
          Close button is absolutely placed, so padding would leave it under the status bar. */}
      <SheetContent
        side="top"
        aria-describedby={undefined}
        className="inset-0 h-dvh max-h-none w-full gap-0 border-b-0 pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col p-3">
          {React.cloneElement(children, { presentation: "sheet" })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export {
  TopBar, TopBarBrand, TopBarWorkspace, TopBarSearch, TopBarActions, TopBarAction,
  TopBarBadge, TopBarDivider, TopBarPill, TopBarUser, TopBarItems, TopBarSearchSlot,
};
