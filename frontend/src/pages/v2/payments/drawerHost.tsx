import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, X } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { DiscardConfirm } from '@/ui-kit/components/ui/discardConfirm';
import { SheetClose, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/ui-kit/components/ui/sheet';
import { useDirtyGuard } from '@/ui-kit/hooks/useDirtyGuard';

import {
  LEGACY_KEYS, STACK_PARAM, parseStack, pushOnto, serializeStack, viewKey, viewLabel, type DrawerKind, type DrawerView,
} from './drawerStack';

interface OpenOptions {
  /** Data the opener already has, keyed `kind:id`, so the view shows at once while its detail loads. */
  seeds?: Record<string, unknown>;
}

export interface DrawerHost {
  /** The views, bottom first; the last one is on screen. */
  stack: DrawerView[];
  /** Start a new stack from outside the drawer (history PUSH). */
  open: (views: DrawerView[], options?: OpenOptions) => void;
  /** Push views on top of what is showing (history PUSH). A view already in the stack cuts back to it. */
  push: (...views: DrawerView[]) => void;
  /** Pop one view (a REPLACE: the in-drawer Back adds no history entry). Asks first if the view holds unsaved work. */
  back: () => void;
  /** Close the whole drawer by removing `d`. Asks first if the view holds unsaved work. */
  close: () => void;
  /** Close with no question: the work is done (an action succeeded). */
  closeNow: () => void;
  /** Swap the whole stack with no question and no history entry (a REPLACE): the work is done, or the view cannot be shown. */
  replace: (views: DrawerView[]) => void;
  /** The element that opened the drawer; it gets focus back on close. */
  openerRef: { current: HTMLElement | null };
  seedOf: (kind: DrawerKind, id: string) => unknown;
  /** The shown view says whether it holds unsaved work; Back, Close, Escape and the scrim ask before discarding it. */
  setDirty: (dirty: boolean) => void;
  /** Radix's `onOpenChange` for the one Sheet. */
  onOpenChange: (open: boolean) => void;
  /** The label of the control that pushed the shown view, handed once to the view Back returns to (undefined: none pending). */
  takeRestore: () => string | null | undefined;
  scrollFor: (view: DrawerView) => number;
  saveScroll: (view: DrawerView, top: number) => void;
}

const Ctx = createContext<DrawerHost | null>(null);

export function useDrawerHost(): DrawerHost {
  const host = useContext(Ctx);
  if (!host) throw new Error('useDrawerHost needs <PaymentsDrawerProvider>');
  return host;
}

/**
 * The state of the Payments drawer: the stack read from the address (`d`), the ways to change it, and the one
 * "unsaved work" question. The address is the only state, so a link, a reload and the browser's Back button all agree.
 */
export function PaymentsDrawerProvider({ children }: { children: ReactNode }) {
  const [params, setSearchParams] = useSearchParams();
  const { stack, legacy } = useMemo(() => parseStack(params), [params]);
  const top = stack.at(-1) ?? null;
  const topKey = top ? viewKey(top) : '';
  const openerRef = useRef<HTMLElement | null>(null);
  const seeds = useRef(new Map<string, unknown>());
  const scrolls = useRef(new Map<string, number>());
  // Labels of the controls that pushed each view, so Back can put focus on the one that is still on screen.
  const pushedBy = useRef<Array<string | null>>([]);
  const restore = useRef<string | null | undefined>(undefined);

  const write = useCallback(
    (next: DrawerView[], replace: boolean) => {
      setSearchParams((prev) => {
        const out = new URLSearchParams(prev);
        for (const key of LEGACY_KEYS) out.delete(key);
        if (next.length) out.set(STACK_PARAM, serializeStack(next));
        else out.delete(STACK_PARAM);
        return out;
      }, { replace });
    },
    [setSearchParams],
  );

  // An old address (`?payment=`, `?payout=&payment=`, `?dispute=`) is read as a stack, then rewritten as `d` (a REPLACE).
  useEffect(() => {
    if (legacy) write(stack, true);
  }, [legacy, stack, write]);

  const [dirtyState, setDirtyState] = useState({ key: '', dirty: false });
  const dirty = dirtyState.key === topKey && dirtyState.dirty;
  const setDirty = useCallback((next: boolean) => setDirtyState({ key: topKey, dirty: next }), [topKey]);

  // What Discard does. Set by the control that asked; when the browser's own Back asked, nothing was set and Discard
  // does what the in-drawer Back does (one view back, or close from the first view).
  const action = useRef<(() => void) | null>(null);
  const fallback = useRef<() => void>(() => {});
  const guard = useDirtyGuard({
    dirty,
    onClose: () => {
      const run = action.current ?? fallback.current;
      action.current = null;
      run();
    },
  });

  const ask = (run: () => void) => {
    action.current = run;
    guard.requestDismiss('close');
  };
  const closeNow = () => {
    scrolls.current.clear();
    pushedBy.current = [];
    write([], false);
  };
  const backNow = () => {
    if (stack.length < 2) return;
    if (top) scrolls.current.delete(viewKey(top));
    restore.current = pushedBy.current.pop() ?? null;
    write(stack.slice(0, -1), true);
  };

  useEffect(() => {
    fallback.current = () => (stack.length > 1 ? backNow() : closeNow());
  });

  const host: DrawerHost = {
    stack,
    open: (views, options) => {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      scrolls.current.clear();
      pushedBy.current = [];
      seeds.current = new Map(Object.entries(options?.seeds ?? {}));
      write(pushOnto([], views), false);
    },
    push: (...views) => {
      const active = document.activeElement;
      const next = pushOnto(stack, views);
      // A push that cuts back to a view underneath is not a deeper view: nothing to remember for it.
      if (next.length > stack.length) {
        pushedBy.current.length = stack.length - 1 < 0 ? 0 : stack.length - 1;
        pushedBy.current[stack.length - 1] = active instanceof HTMLElement ? (active.getAttribute('aria-label') ?? active.textContent?.trim() ?? null) : null;
      }
      write(next, false);
    },
    takeRestore: () => { const r = restore.current; restore.current = undefined; return r; },
    back: () => ask(backNow),
    close: () => ask(closeNow),
    closeNow,
    replace: (views) => {
      if (top) scrolls.current.delete(viewKey(top));
      pushedBy.current = [];
      write(pushOnto([], views), true);
    },
    openerRef,
    seedOf: (kind, id) => seeds.current.get(`${kind}:${id}`),
    setDirty,
    onOpenChange: (open) => { if (!open) ask(closeNow); },
    scrollFor: (view) => scrolls.current.get(viewKey(view)) ?? 0,
    saveScroll: (view, y) => { scrolls.current.set(viewKey(view), y); },
  };

  return (
    <Ctx.Provider value={host}>
      {children}
      <DiscardConfirm
        {...guard.confirmProps}
        onKeepEditing={() => { action.current = null; guard.confirmProps.onKeepEditing(); }}
      />
    </Ctx.Provider>
  );
}

/**
 * The top of every view: Back (from the second view on, a 40px outline button saying which view is underneath, 44px on a
 * phone) beside the title. The Close X is the sheet's own, at the far right, and closes the whole drawer.
 */
export function DrawerHeaderBar({ title }: { title: string }) {
  const host = useDrawerHost();
  const below = host.stack.length > 1 ? host.stack[host.stack.length - 2]! : null;
  const backRef = useRef<HTMLButtonElement>(null);
  const hasBack = below != null;
  // Arriving on a deeper view puts focus on Back; the view is keyed, so this runs once per arrival.
  useEffect(() => {
    if (hasBack) backRef.current?.focus();
  }, [hasBack]);
  return (
    <SheetHeader className="pr-4.5 touch:pr-4.5">
      <div className="flex items-center gap-3">
        {below && (
          <Button
            ref={backRef}
            type="button"
            variant="outline"
            className="h-10 shrink-0 gap-1 px-3 max-md:h-11"
            aria-label={`Back to ${viewLabel(below)}`}
            onClick={host.back}
          >
            <ChevronLeft aria-hidden />
            {viewLabel(below)}
          </Button>
        )}
        <SheetTitle className="min-w-0 flex-1 [overflow-wrap:anywhere]">{title}</SheetTitle>
        {/* Always at the far right; closes the whole drawer (not one view). Named apart from the footer's "Close". */}
        <SheetClose asChild>
          <Button type="button" variant="ghost" size="icon" aria-label="Close drawer" className="shrink-0 max-md:size-11">
            <X aria-hidden />
          </Button>
        </SheetClose>
      </div>
      <SheetDescription className="sr-only">{title}</SheetDescription>
    </SheetHeader>
  );
}

/** The scrolling part of a view. Where it was scrolled is kept per view, so Back shows the earlier view as it was left. */
export function DrawerBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  const host = useDrawerHost();
  // Null while the sheet slides out after a close.
  const view = host.stack.at(-1) ?? null;
  const ref = useRef<HTMLDivElement>(null);
  const { scrollFor } = host;
  useLayoutEffect(() => {
    if (ref.current && view) ref.current.scrollTop = scrollFor(view);
    // Once per arrival: the view is keyed by the host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Back by keyboard: focus goes to the control that pushed the view you left, if it is on screen, else the view's title.
  useEffect(() => {
    const label = host.takeRestore();
    if (label === undefined) return;
    let tries = 0;
    const focusTitle = (root: Element | null | undefined) => {
      const title = root?.querySelector<HTMLElement>('[data-slot="sheet-title"]');
      if (title) { title.tabIndex = -1; title.focus(); }
    };
    const timer = setInterval(() => {
      const root = ref.current?.closest('[role="dialog"]');
      const hit = label ? Array.from(root?.querySelectorAll<HTMLElement>('button, a') ?? []).find(
        (el) => !el.closest('[data-slot="sheet-header"]') && (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label,
      ) : undefined;
      if (hit) { hit.focus(); clearInterval(timer); return; }
      if (++tries > 20) { focusTitle(root); clearInterval(timer); }
    }, 25);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      className={`flex flex-1 flex-col gap-4 overflow-y-auto p-5 [&>*]:shrink-0 ${className}`}
      onScroll={(event) => { if (view) host.saveScroll(view, event.currentTarget.scrollTop); }}
    >
      {children}
    </div>
  );
}

/** "Close", pushed to the right end of a footer. */
export function DrawerCloseButton() {
  const host = useDrawerHost();
  return (
    <Button type="button" variant="outline" className="ml-auto" onClick={host.close}>Close</Button>
  );
}

/**
 * The bottom of a view. `oneRow` is for a footer with four actions and Close (V7-09c, the mockup's `drawer-foot--one`):
 * left-aligned, 8px between, 12px side padding on the buttons and no wrapping inside a label, so the buttons share one
 * row whenever the drawer is wide enough and the last ones drop to a second row (never off the edge) when it is not. Two
 * to a row on a phone.
 */
export function DrawerFooter({ children, oneRow = false }: { children: ReactNode; oneRow?: boolean }) {
  return (
    <SheetFooter
      className={oneRow
        ? 'justify-start gap-2 max-sm:[&>*]:flex-1 max-sm:[&>*]:basis-[calc(50%-8px)] sm:[&>button]:px-3 sm:[&>button]:whitespace-nowrap'
        : undefined}
    >
      {children}
    </SheetFooter>
  );
}
