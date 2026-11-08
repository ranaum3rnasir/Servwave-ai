"use client";

import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { useMediaQuery } from "@/ui-kit/hooks/useMediaQuery";

export type SidebarMode = "expanded" | "rail";

interface SidebarContextValue {
  mode: SidebarMode;
  /** True only when collapsed AND on desktop - mobile uses a drawer instead. */
  isRail: boolean;
  isMobile: boolean;
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
}

/**
 * The application frame.
 *
 *   .app                      flex column, 100vh, gains `.is-rail` when collapsed
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
 * Geometry, colour and motion live in `shell.css`, keyed off `.app.is-rail`.
 * That single ancestor class is what lets the width, the labels and the active
 * indicator share one curve and one duration instead of threading a boolean
 * through every descendant.
 */
function AppShell({
  className, sidebar, topbar, children,
  defaultMode = "expanded",
  // Matches the shell.css breakpoint. If the two ever disagree, there is a band
  // of widths where the CSS lays out a column and the JS thinks it is a drawer.
  mobileBreakpoint = "(max-width: 760px)",
  flush = false,
  ...props
}: AppShellProps) {
  const isMobile = useMediaQuery(mobileBreakpoint);
  const [mode, setMode] = React.useState<SidebarMode>(defaultMode);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Crossing into mobile starts with the drawer shut, so a drawer left open
  // before a resize cannot reappear. Deferred by a tick rather than set
  // synchronously in the effect body, which would cascade a second render
  // (react-hooks/set-state-in-effect); the drawer only renders on mobile and
  // its own default is closed, so the tick is not observable.
  React.useEffect(() => {
    if (!isMobile) return;
    const reset = setTimeout(() => setDrawerOpen(false), 0);
    return () => clearTimeout(reset);
  }, [isMobile]);

  React.useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isMobile, drawerOpen]);

  const value = React.useMemo<SidebarContextValue>(() => ({
    mode,
    isRail: mode === "rail" && !isMobile,
    isMobile,
    drawerOpen,
    toggle: () =>
      isMobile
        ? setDrawerOpen((open) => !open)
        : setMode((current) => (current === "rail" ? "expanded" : "rail")),
    closeDrawer: () => setDrawerOpen(false),
  }), [mode, isMobile, drawerOpen]);

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="app-shell"
        className={cn("app", value.isRail && "is-rail", className)}
        {...props}
      >
        {topbar}

        <div data-slot="app-body" className="shell">
          {sidebar}

          {isMobile && (
            <div
              aria-hidden
              data-open={drawerOpen}
              onClick={() => setDrawerOpen(false)}
              className="app-scrim"
            />
          )}

          <div data-slot="app-canvas" className="canvas">
            <main data-slot="app-canvas-body" className={cn("canvas-body", flush && "is-flush")}>
              {children}
            </main>
          </div>
        </div>
      </div>
    </SidebarContext.Provider>
  );
}

export { AppShell };
