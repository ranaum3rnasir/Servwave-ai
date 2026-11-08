"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronDown, GripVertical, PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui-kit/components/ui/tooltip";
import { useSidebar } from "@/ui-kit/components/layout/appShell";

/**
 * Navigation column.
 *
 * No border, no radius and no fill of its own - it IS the page background, so
 * it never draws a line against the canvas beside it. Everything it paints is a
 * tint of that surface. Grouping comes from spacing and one moving indicator,
 * not from an edge.
 *
 * Collapsed it becomes a 60px icon rail; labels move into tooltips. All of the
 * geometry is in shell.css under `.sidebar` / `.app.is-rail .sidebar`.
 */
function Sidebar({ className, children, ...props }: React.ComponentProps<"aside">) {
  const { isRail, isMobile, drawerOpen } = useSidebar();

  return (
    <aside
      data-slot="sidebar"
      data-mode={isRail ? "rail" : "expanded"}
      // Only present on mobile, so the drawer transform rules in shell.css can
      // never reach the desktop column.
      data-drawer={isMobile ? (drawerOpen ? "open" : "closed") : undefined}
      aria-label="Main navigation"
      className={cn("sidebar", className)}
      {...props}
    >
      {children}
    </aside>
  );
}

/**
 * Scroll area plus the ONE travelling active-page indicator.
 *
 * The indicator has to be a single element. Nine per-item backgrounds can only
 * cross-fade in place - there is nothing for a transition to move - whereas one
 * shared element can travel, which is the entire effect. It is measured from
 * the DOM here and positioned by writing `transform` (never `top`: animating
 * `top` re-runs layout every frame, a transform goes straight to the
 * compositor).
 *
 * The write is imperative rather than React state on purpose. State would
 * re-render the tree that owns the rail on the same tick the active item
 * changes, and a re-render that recreates the node destroys the transition
 * mid-flight - the documented failure where the indicator silently never
 * animates. A style write on a stable ref cannot do that.
 */
function SidebarNav({ className, children, ...props }: React.ComponentProps<"nav">) {
  const { isRail } = useSidebar();
  const navRef = React.useRef<HTMLElement>(null);
  const railRef = React.useRef<HTMLSpanElement>(null);

  const placeRail = React.useCallback(() => {
    const nav = navRef.current;
    const rail = railRef.current;
    if (!nav || !rail) return;

    const active = nav.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) {
      rail.classList.add("is-hidden");
      return;
    }
    // Expanded it is a short bar inset from the row and flush to the sidebar's
    // left edge; collapsed it is the full square behind the icon. Same element
    // either way, so the travel animates in both states.
    const inset = isRail ? 0 : 6;
    rail.style.height = `${active.offsetHeight - inset * 2}px`;
    rail.style.transform = `translateY(${active.offsetTop + inset}px)`;
    rail.classList.remove("is-hidden");
  }, [isRail]);

  React.useLayoutEffect(() => {
    placeRail();
    const nav = navRef.current;
    if (!nav) return;

    // data-active flips without remounting anything, and items can be added or
    // removed by permission gating, so both kinds of mutation have to re-place
    // the rail. The ResizeObserver covers the third case the preview got wrong
    // twice: a width change (window resize, collapse) moves the rows without
    // touching a single attribute.
    const attributes = new MutationObserver(placeRail);
    attributes.observe(nav, {
      attributes: true,
      subtree: true,
      childList: true,
      attributeFilter: ["data-active"],
    });
    const resize = new ResizeObserver(placeRail);
    resize.observe(nav);

    return () => {
      attributes.disconnect();
      resize.disconnect();
    };
  }, [placeRail]);

  return (
    <nav ref={navRef} data-slot="sidebar-nav" className={cn("sb-nav", className)} {...props}>
      {/* Starts hidden so the very first paint cannot flash a rail parked at
          the top of the list; the layout effect above places it before paint. */}
      <span ref={railRef} aria-hidden className="nav-rail is-hidden" />
      {children}
    </nav>
  );
}

/** Expand / collapse. Named for what it does - a burger would say "menu". */
function SidebarToggle({ className, ...props }: React.ComponentProps<"button">) {
  const { isRail, toggle } = useSidebar();
  const label = isRail ? "Expand sidebar" : "Collapse sidebar";

  return (
    <button
      type="button"
      data-slot="sidebar-toggle"
      onClick={toggle}
      aria-expanded={!isRail}
      aria-label={label}
      title={label}
      className={cn("sb-toggle", className)}
      {...props}
    >
      {isRail ? <PanelLeftOpen /> : <PanelLeftClose />}
    </button>
  );
}

export interface SidebarGroupLabelProps extends React.ComponentProps<"div"> {
  /**
   * Puts the collapse control inline with this heading. Set it on the FIRST
   * group only: the sidebar then opens straight into the nav instead of
   * spending a whole row on a single button.
   */
  withToggle?: boolean;
}

function SidebarGroupLabel({ className, withToggle, children, ...props }: SidebarGroupLabelProps) {
  if (withToggle) {
    return (
      <div data-slot="sidebar-group-row" className={cn("sb-group-row", className)} {...props}>
        <span className="sb-group">{children}</span>
        <SidebarToggle />
      </div>
    );
  }
  return (
    <div data-slot="sidebar-group-label" className={cn("sb-group", className)} {...props}>
      {children}
    </div>
  );
}

export interface SidebarItemProps extends React.ComponentProps<"button"> {
  active?: boolean;
  icon: React.ReactNode;
  label: string;
  count?: string | number;
  /** Renders as a non-navigating, dimmed row - plan-locked destinations. */
  locked?: boolean;
  asChild?: boolean;
  /**
   * Lifts the row out of the destination list.
   *
   * `"ai"` is the one value the kit ships: a launcher that opens an AI surface
   * rather than navigating anywhere, drawn in the app's reserved lavender ramp
   * so it cannot be mistaken for the next nav row. Appearance stays in
   * shell.css (`.sb-item.is-ai`) like every other state this row has.
   */
  emphasis?: "ai";
  /**
   * Turns the row into the header of an expandable group: adds the disclosure
   * chevron and announces the state. Set it (to either value) only on a row
   * that toggles rather than navigates.
   */
  expanded?: boolean;
  /** A row rendered inside an open group - indented under its parent. */
  nested?: boolean;
}

/** Wraps itself in a tooltip only in rail mode, where the label is hidden. */
function SidebarItem({
  className, active, icon, label, count, locked, asChild, emphasis, expanded, nested,
  onClick, children, ...props
}: SidebarItemProps) {
  const { isRail, isMobile, closeDrawer } = useSidebar();
  const Comp = asChild ? Slot : "button";

  // Picking a destination on mobile has to dismiss the drawer, or the page you
  // just navigated to arrives underneath it. Composed rather than replacing the
  // caller's handler: under asChild the caller's own onClick lives on the link
  // and Slot merges the two, so both still run.
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    // A disclosure row goes nowhere, so dismissing the drawer would hide the
    // children the tap just revealed.
    if (isMobile && expanded === undefined) closeDrawer();
  };

  // The row's own content: icon, label, optional count. Both the label and the
  // count keep their elements in rail mode - shell.css collapses them to zero
  // width, which is what the opacity transition has to animate against.
  const content = (
    <>
      {icon}
      <span className="sb-label">{label}</span>
      {count != null && <span className="sb-count">{count}</span>}
      {expanded !== undefined && (
        <ChevronDown aria-hidden className={cn("sb-chevron", !expanded && "is-closed")} />
      )}
    </>
  );

  // Radix's Slot takes EXACTLY ONE element child and merges props onto it.
  // Rendering icon/label/count directly into it threw "Slot failed to slot onto
  // its children" and took the whole page down with it. Under asChild the
  // caller's element (typically a link) is the one child, and the row's content
  // goes inside it.
  const body =
    asChild && React.isValidElement(children)
      ? React.cloneElement(children as React.ReactElement<{ children?: React.ReactNode }>, undefined, content)
      : content;

  const item = (
    <Comp
      data-slot="sidebar-item"
      data-active={active || undefined}
      aria-current={active ? "page" : undefined}
      aria-disabled={locked || undefined}
      aria-expanded={expanded}
      title={label}
      className={cn(
        "sb-item",
        active && "is-active",
        locked && "is-locked",
        nested && "is-nested",
        emphasis === "ai" && "is-ai",
        className,
      )}
      onClick={handleClick}
      {...props}
    >
      {body}
    </Comp>
  );

  if (!isRail) return item;

  // asChild keeps the row as the sole child, so nothing wraps it in an
  // inline-flex span that would collapse its width and break the centring.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The block above the nav, for the column's one global action.
 *
 * Outside SidebarNav for the same reason the footer is: the travelling rail
 * measures rows inside the nav against the nav's own box, and a control that is
 * not a destination must neither be measured as one nor push every measurement
 * down by its own height.
 */
function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-header" className={cn("sb-header", className)} {...props} />;
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-footer" className={cn("sb-footer", className)} {...props} />;
}

/**
 * The strip between the header and the nav, for a control that acts on the
 * NAVIGATION LIST itself rather than on the app - editing which destinations
 * are pinned and in what order.
 *
 * Outside SidebarNav, like the header and the footer, for the same two reasons:
 * the travelling rail measures rows inside the nav and must not measure this
 * one, and a control that reshapes the list has to stay put while the list it
 * reshapes scrolls under it.
 *
 * It disappears entirely in rail mode (shell.css, `.app.is-rail .sb-toolbar`).
 * A 60px column has no room for a labelled control, and the rows it edits have
 * no labels to reorder by, so the whole affordance goes rather than degrade.
 */
function SidebarToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-toolbar" className={cn("sb-toolbar", className)} {...props} />;
}

/**
 * A nav row while the list is being edited: the row itself plus whatever
 * controls act on it.
 *
 * A wrapper rather than props on SidebarItem, because the row renders as a link
 * or a button and the controls beside it are buttons too - nesting one inside
 * the other is invalid markup and unreachable by keyboard. The dashed outline
 * is what says the list is in a mode, not just that a row is hovered.
 */
function SidebarEditRow({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-edit-row" className={cn("sb-edit-row", className)} {...props} />;
}

export interface SidebarDragHandleProps extends React.ComponentProps<"span"> {
  /** Accessible name, e.g. `Reorder Leads`. The glyph carries no label. */
  label: string;
}

/**
 * The grab point for reordering a row.
 *
 * `draggable` lives HERE and not on the whole row: a row is a link, and a
 * draggable link is dragged by its href in every browser, so the drag never
 * reaches the handler and the reorder silently does nothing.
 */
function SidebarDragHandle({ className, label, ...props }: SidebarDragHandleProps) {
  return (
    <span
      data-slot="sidebar-drag-handle"
      draggable
      role="button"
      aria-label={label}
      className={cn("sb-grip", className)}
      {...props}
    >
      <GripVertical aria-hidden />
    </span>
  );
}

export {
  Sidebar, SidebarNav, SidebarToggle, SidebarGroupLabel, SidebarItem,
  SidebarHeader, SidebarFooter, SidebarToolbar, SidebarEditRow, SidebarDragHandle,
};
