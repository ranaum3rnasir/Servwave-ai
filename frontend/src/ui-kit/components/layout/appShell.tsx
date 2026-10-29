"use client";

import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { useMediaQuery } from "@/ui-kit/hooks/useMediaQuery";
import { MEDIA } from "@/ui-kit/lib/breakpoints";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/ui-kit/components/ui/sheet";

export type SidebarMode = "expanded" | "rail";

interface SidebarContextValue {
  mode: SidebarMode;
  /** True only when collapsed AND on desktop - mobile uses a drawer instead. */
  isRail: boolean;
  /** Phone width: the top bar folds its actions into one overflow menu. */
  isMobile: boolean;
  /**
   * The sidebar is an off-canvas drawer: phone width, OR a landscape phone (wide but short, so an
   * inline column would leave no room for the page). Navigation chrome keys off this, never off
   * `isMobile`, which stays about the top bar.
   */
  isDrawer: boolean;
  /**
   * Tablet and unfolded foldable (md up to lg, at normal height): the column is the 60 px icon
   * rail, always, and expanding it opens the full sidebar as an overlay over the rail and the page
   * instead of pushing the page (mobile slice 35). Inside that overlay `isDrawer` is true and
   * `isRail` false, so the rows render as they do in the phone drawer; this flag stays true there
   * so a part that belongs only to the phone drawer (the account block, which the top bar's
   * avatar menu already carries at this width) can tell the two apart.
   */
  isRailTier: boolean;
  drawerOpen: boolean;
  toggle: () => void;
  closeDrawer: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within <AppShell>");
  return context;
}

export interface AppShellProps extends React.ComponentProps<"div"> {
  sidebar: React.ReactNode;
  topbar: React.ReactNode;
  defaultMode?: SidebarMode;
  /**
   * Where the sidebar becomes a drawer. A named query from `MEDIA`, never a
   * pixel width of the caller's own. Defaults to below `md`.
   */
  mobileBreakpoint?: string;
  /**
   * Hand the whole canvas to the page: no gutter, no page-level scroll.
   *
   * For the one kind of page that IS a surface rather than a document on a
   * surface - the schedule board. A board already scrolls in two axes of its
   * own, so the canvas scrolling underneath it produces two nested scrollbars
   * on the same gesture, and the 26px frame around it is 26px of schedule
   * nobody can see. A flush page is expected to fill its own height.
   */
  flush?: boolean;
  /**
   * Bound the page to the canvas and let it fill what the breadcrumb row leaves (mobile slice 69).
   *
   * For a page that lays itself out as a column of fixed chrome and ONE scroller of its own - the
   * two-pane messengers. Left to the default, such a page is `h-full` inside a canvas that also
   * scrolls and also carries the breadcrumb row above it, so the page is taller than the room it
   * has and the canvas scrolls too: two vertical scrollers on one gesture, with the composer
   * pushed below the fold. Bounded, the canvas is a column that never scrolls, the breadcrumb keeps
   * its height, and the page takes the rest with `flex-1 min-h-0`. Unlike `flush` it keeps the
   * gutter and the breadcrumb row, and below md it lifts the page's bottom edge over the on-screen
   * keyboard (the inset mobile slice 54 publishes) so a composer there is never covered.
   */
  bounded?: boolean;
  /**
   * Any change closes the drawer (pass the route), so a destination reached some way other than a
   * tap on a row - a link inside the account block, a deep link - cannot leave it over the page.
   */
  drawerResetKey?: unknown;
  /**
   * Ref to the page scroller (the `<main>` the canvas scrolls in), for the app to manage its
   * position across navigations. The kit knows nothing about routing, so it only exposes it.
   */
  canvasRef?: React.Ref<HTMLElement>;
}

/**
 * The application frame.
 *
 *   .app                      flex column, dynamic viewport height, gains `.is-rail` when collapsed
 *   |- .topbar                50px, FULL WIDTH, transparent
 *   `- .shell                 flex row
 *      |- .sidebar            192px -> 60px, transparent, no border, no fill
 *      `- .canvas             the only white surface, rounded
 *         `- .canvas-body     the page
 *
 * The topbar is app chrome, so it sits ABOVE the shell rather than inside the
 * canvas: global controls belong to the app, not to the page, and nothing in
 * that bar should shift because a navigation panel underneath it changed width.
 * The canvas IS the page.
 *
 * The sidebar has no surface of its own on purpose. A bordered sidebar beside a
 * bordered topbar above bordered panels puts four hairlines through every corner
 * of the screen, and a grid of intersecting hairlines is what a table looks
 * like. Removing the borders - not adding more - is the fix.
 *
 * Collapsing shrinks the sidebar to an icon rail rather than hiding it.
 * Navigation that disappears forces a mode switch every time you need it; a rail
 * keeps every destination one click away and costs 60px.
 *
 * Three navigation tiers, by the named breakpoints (never a pixel width of our own):
 *   - phones (below md) and landscape phones (short height): an off-canvas drawer;
 *   - tablets and unfolded foldables (md up to lg, normal height): the 60px rail
 *     is always the column, and expanding it opens the full sidebar as an overlay
 *     over the rail and the page (a modal sheet, portalled to <body> so it is placed
 *     against the window and never inside the content column), instead of pushing
 *     the page;
 *   - lg and up: the full column, with the user's own collapse-to-rail toggle.
 *
 * Geometry, colour and motion live in `shell.css`, keyed off `.app.is-rail`.
 * That single ancestor class is what lets the width, the labels and the active
 * indicator share one curve and one duration instead of threading a boolean
 * through every descendant.
 */
function AppShell({
  className, sidebar, topbar, children,
  defaultMode = "expanded",
  // Below md, the same named query shell.css uses verbatim. If the two ever
  // disagree there is a band of widths where the CSS lays out a column and the
  // JS thinks it is a drawer - which is what the old private 760 px value next
  // to the phone hook's 768 px was.
  mobileBreakpoint = MEDIA.belowMd,
  flush = false,
  bounded = false,
  drawerResetKey,
  canvasRef,
  ...props
}: AppShellProps) {
  const isMobile = useMediaQuery(mobileBreakpoint);
  const isShort = useMediaQuery(MEDIA.shortHeight);
  const isDrawer = isMobile || isShort;
  // The rail tier: md up to lg at normal height. The same named queries the CSS and Tailwind read,
  // so it ends exactly where the `lg:` utilities begin.
  const isBelowLg = useMediaQuery(MEDIA.belowLg);
  const isRailTier = !isDrawer && isBelowLg;
  const navLayout = isDrawer ? "drawer" : isRailTier ? "rail-tier" : "column";
  const [mode, setMode] = React.useState<SidebarMode>(defaultMode);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Crossing between layouts (column, rail tier, drawer) in either direction starts with the
  // overlay shut, so one left open before a resize cannot reappear, and a layout with no overlay
  // cannot leave it remembered as open. Deferred by a tick rather than set synchronously in the
  // effect body, which would cascade a second render (react-hooks/set-state-in-effect).
  React.useEffect(() => {
    const reset = setTimeout(() => setDrawerOpen(false), 0);
    return () => clearTimeout(reset);
  }, [navLayout]);

  // Close on a new route: adjust state during render (React's documented pattern) rather than in an
  // effect, which would paint the open drawer over the new page for a frame first.
  const [seenKey, setSeenKey] = React.useState(drawerResetKey);
  if (seenKey !== drawerResetKey) {
    setSeenKey(drawerResetKey);
    if (drawerOpen) setDrawerOpen(false);
  }

  const value = React.useMemo<SidebarContextValue>(() => ({
    mode,
    // The rail tier is the rail whatever the user chose for the wide layout: that choice belongs
    // to lg and up, where it still applies.
    isRail: !isDrawer && (isRailTier || mode === "rail"),
    isMobile,
    isDrawer,
    isRailTier,
    drawerOpen,
    toggle: () =>
      isDrawer || isRailTier
        ? setDrawerOpen((open) => !open)
        : setMode((current) => (current === "rail" ? "expanded" : "rail")),
    closeDrawer: () => setDrawerOpen(false),
  }), [mode, isMobile, isDrawer, isRailTier, drawerOpen]);

  // What the sidebar sees inside the rail tier's overlay: the full sidebar, laid out the way the
  // phone drawer lays it out (expanded rows, Create New expanding in place, a row tap closes it).
  const overlayValue = React.useMemo<SidebarContextValue>(
    () => ({ ...value, isRail: false, isDrawer: true }),
    [value],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="app-shell"
        className={cn("app", value.isRail && "is-rail", className)}
        {...props}
      >
        {topbar}

        <div data-slot="app-body" className="shell">
          {/* A drawer is a modal dialog (a left-edge sheet), not a column that slides: while shut
              it is not rendered at all, so it is out of the accessibility tree and the tab order,
              and while open the dialog primitive owns focus (moved in, trapped, returned to the
              trigger) and Escape. */}
          {isDrawer ? (
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetContent
                side="left"
                showClose={false}
                data-slot="nav-drawer"
                // Radix returns focus only to a Dialog.Trigger it owns, and the drawer's opener
                // lives in the top bar, so without this focus would fall to <body> on close.
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  document.querySelector<HTMLElement>('[data-slot="topbar-nav-trigger"]')?.focus();
                }}
                // The sidebar inside pads itself for the status bar, the home indicator and the notch
                // side (shell.css, `.sidebar[data-drawer]`), so the sheet's own edge inset is turned
                // off, and the width grows by the left inset to leave the rows their 20rem
                // (mobile slice 52).
                className="h-dvh w-[min(calc(20rem+env(safe-area-inset-left,0px)),calc(100vw-48px))] gap-0 overflow-hidden border-0 p-0"
              >
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <SheetDescription className="sr-only">Pages, create actions and your account</SheetDescription>
                {sidebar}
              </SheetContent>
            </Sheet>
          ) : (
            <>
              {/* The sidebar column: the 60 px rail in the flow in the rail tier, the full column
                  at lg and up. */}
              {sidebar}
              {/* The rail tier's overlay. Like the phone drawer it is a modal dialog portalled to
                  <body>: positioned against the whole window, never inside the content column; it
                  covers the rail and the page rather than pushing them; and while shut it is not
                  rendered at all, so it is out of the accessibility tree and the tab order and
                  nothing is left to paint over the rail. */}
              {isRailTier && (
                <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
                  <SheetContent
                    side="left"
                    showClose={false}
                    data-slot="nav-overlay"
                    // The opener is the rail's own toggle, which is not a Dialog.Trigger either.
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      document
                        .querySelector<HTMLElement>('[data-slot="app-body"] [data-slot="sidebar-toggle"]')
                        ?.focus();
                    }}
                    // pt-3: with no account block above it (the avatar menu is in the top bar at this
                    // width) Create New would otherwise sit flush against the window's top edge.
                    className="h-dvh w-[min(calc(20rem+env(safe-area-inset-left,0px)),calc(100vw-48px))] gap-0 overflow-hidden border-0 p-0 pt-3"
                  >
                    <SheetTitle className="sr-only">Navigation</SheetTitle>
                    <SheetDescription className="sr-only">Pages and create actions</SheetDescription>
                    <SidebarContext.Provider value={overlayValue}>{sidebar}</SidebarContext.Provider>
                  </SheetContent>
                </Sheet>
              )}
            </>
          )}

          <div data-slot="app-canvas" className="canvas">
            <main ref={canvasRef} data-slot="app-canvas-body" className={cn("canvas-body", flush && "is-flush", bounded && "is-bounded")}>
              {children}
            </main>
          </div>
        </div>
      </div>
    </SidebarContext.Provider>
  );
}

export { AppShell };
