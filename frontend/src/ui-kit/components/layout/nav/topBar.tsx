"use client";

import * as React from "react";
import { PanelLeftOpen, Search } from "lucide-react";
import { Slot } from "@radix-ui/react-slot";

import { cn } from "@/ui-kit/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui-kit/components/ui/tooltip";
import { useSidebar } from "@/ui-kit/components/layout/appShell";

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
function TopBar({ className, children, ...props }: React.ComponentProps<"header">) {
  const { isMobile, toggle } = useSidebar();
  return (
    <header data-slot="topbar" className={cn("topbar", className)} {...props}>
      {/* Desktop has no opener here - collapsing lives on the sidebar itself,
          inline with its first group heading. Mobile needs one, because the
          drawer is fully off-screen. */}
      {isMobile && (
        <TopBarAction label="Open navigation" onClick={toggle}>
          <PanelLeftOpen />
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
      <input type="search" aria-label="Search" {...props} />
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

export {
  TopBar, TopBarBrand, TopBarWorkspace, TopBarSearch, TopBarActions, TopBarAction,
  TopBarBadge, TopBarDivider, TopBarPill, TopBarUser,
};
