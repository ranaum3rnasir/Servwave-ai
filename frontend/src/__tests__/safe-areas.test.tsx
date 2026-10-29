/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Mobile slice 52 (rubric VP-02 and PWA-02): the installed app's top bar, drawer and bottom bars
 * clear the notch, the status bar and the home indicator.
 *
 * `viewport-fit=cover` lets the page run under all three, so every edge element has to pad for
 * them with `env(safe-area-inset-*)`. jsdom has no layout engine and no safe-area insets, so this
 * reads the head and the stylesheet as source, reads the class strings the primitives render, and
 * runs a source guard over every fixed bottom bar. The real-browser proof, with the insets
 * emulated, is e2e/mobile/safe-areas.spec.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell, useSidebar } from '@/ui-kit/components/layout/appShell';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { TopBarSearchSlot } from '@/ui-kit/components/layout/nav/topBar';
import { Dialog, DialogContent, DialogTitle } from '@/ui-kit/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle, sheetVariants } from '@/ui-kit/components/ui/sheet';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { IconRail } from '@/components/crm/IconRail';
import { renderWithProviders } from './helpers';

const FRONTEND = path.resolve(__dirname, '../..');
const SRC = path.join(FRONTEND, 'src');
const read = (file: string) => readFileSync(path.join(FRONTEND, file), 'utf8');

const TOP = 'safe-area-inset-top';
const BOTTOM = 'safe-area-inset-bottom';
const LEFT = 'safe-area-inset-left';
const RIGHT = 'safe-area-inset-right';
// `--safe-bottom` IS the bottom inset, dropped to zero while the keyboard covers it (index.css, slice 54).
const padsBottom = (cls: string) => cls.includes(BOTTOM) || cls.includes('--safe-bottom');

describe('document head', () => {
  for (const page of ['index.html', 'public.html']) {
    it(`${page}: the viewport meta says viewport-fit=cover and still allows zoom`, () => {
      const doc = new DOMParser().parseFromString(read(page), 'text/html');
      const content = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
      const tokens = content.split(',').map((t) => t.trim());
      expect(tokens).toContain('viewport-fit=cover');
      expect(tokens).toContain('width=device-width');
      expect(tokens).toContain('initial-scale=1.0');
      expect(content).not.toMatch(/maximum-scale|user-scalable/);
    });

    // Mobile slice 54: Chrome Android shrinks the layout itself when the keyboard opens, so a footer
    // sits above it with no help; the keyboard-inset hook reports zero there. iOS ignores the key.
    it(`${page}: the viewport meta asks the layout to resize with the keyboard`, () => {
      const doc = new DOMParser().parseFromString(read(page), 'text/html');
      const content = doc.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
      expect(content.split(',').map((t) => t.trim())).toContain('interactive-widget=resizes-content');
    });
  }
});

/** Every rule body in shell.css whose selector is exactly `selector`, at any nesting depth. */
function ruleBodies(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  return [...css.matchAll(re)].map((m) => m[1]);
}
const shellCss = read('src/ui-kit/components/layout/shell.css');
const paddings = (bodies: string[]) => bodies.map((b) => /(?:^|\n)\s*padding:([^;]*);/.exec(b)?.[1]).filter(Boolean) as string[];

describe('shell.css', () => {
  it('the top bar grows by the top inset and pads its sides for the notch, wide and on a phone', () => {
    const bodies = ruleBodies(shellCss, '.topbar');
    expect(bodies.length).toBeGreaterThanOrEqual(2); // the wide rule and the phone override
    expect(bodies.some((b) => /height:\s*calc\(50px \+ env\(safe-area-inset-top/.test(b))).toBe(true);
    const pads = paddings(bodies);
    expect(pads.length).toBe(bodies.length);
    for (const pad of pads) {
      expect(pad).toContain(TOP);
      expect(pad).toContain(LEFT);
      expect(pad).toContain(RIGHT);
    }
  });

  it('the shell frame keeps the page off the notch sides and the home indicator, wide and on a phone', () => {
    const pads = paddings(ruleBodies(shellCss, '.shell'));
    expect(pads.length).toBeGreaterThanOrEqual(2);
    for (const pad of pads) {
      expect(pad).toContain(BOTTOM);
      expect(pad).toContain(LEFT);
      expect(pad).toContain(RIGHT);
    }
  });

  it('the open drawer pads for the status bar, the home indicator and the notch side', () => {
    const pad = paddings(ruleBodies(shellCss, '.sidebar[data-drawer]')).join(' ');
    expect(pad).toContain(TOP);
    expect(pad).toContain(BOTTOM);
    expect(pad).toContain(LEFT);
  });
});

function mockViewport(phone: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: phone && query === MEDIA.belowMd,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}
const mockPhone = () => mockViewport(true);
afterEach(() => vi.restoreAllMocks());

describe('the navigation drawer', () => {
  it('is wide enough that the notch side does not eat into its content', () => {
    mockPhone();
    function Opener() {
      const { toggle } = useSidebar();
      return <button type="button" onClick={toggle}>Open menu</button>;
    }
    render(<AppShell topbar={<Opener />} sidebar={<aside data-slot="sidebar" data-drawer="open">Menu</aside>}>Page</AppShell>);
    act(() => screen.getByRole('button', { name: 'Open menu' }).click());
    const drawer = document.querySelector('[data-slot="nav-drawer"]') as HTMLElement;
    expect(drawer).not.toBeNull();
    expect(drawer.className).toContain(LEFT);
  });
});

describe('edge sheets', () => {
  const edge = (side: 'left' | 'right' | 'top' | 'bottom') => sheetVariants({ side });

  it('a right sheet clears the status bar and the notch on its own edge', () => {
    const cls = edge('right');
    expect(cls).toContain(TOP);
    expect(cls).toContain(RIGHT);
    expect(cls).not.toContain(LEFT);
  });

  it('a left sheet clears the status bar and the notch on its own edge', () => {
    const cls = edge('left');
    expect(cls).toContain(TOP);
    expect(cls).toContain(LEFT);
    expect(cls).not.toContain(RIGHT);
  });

  it('a top sheet clears the status bar and both sides; a bottom sheet clears both sides only', () => {
    expect(edge('top')).toContain(TOP);
    for (const cls of [edge('top'), edge('bottom')]) {
      expect(cls).toContain(LEFT);
      expect(cls).toContain(RIGHT);
    }
    expect(edge('bottom')).not.toContain(TOP);
  });

  it('a full-screen sheet (intent on a phone) clears the status bar and both sides', () => {
    mockPhone();
    render(
      <Sheet open>
        <SheetContent intent="form" aria-describedby={undefined}>
          <SheetTitle>New thing</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    const cls = document.querySelector('[data-slot="sheet-content"]')!.className;
    expect(cls).toContain(TOP);
    expect(cls).toContain(LEFT);
    expect(cls).toContain(RIGHT);
  });

  it('right, left and bottom sheets keep their footer above the home indicator, once', () => {
    for (const side of ['right', 'left', 'bottom'] as const) expect(padsBottom(edge(side))).toBe(true);
    expect(padsBottom(edge('top'))).toBe(false);
    // The sheet reserves the inset, so its footer must not pad for it a second time.
    const src = read('src/ui-kit/components/ui/sheet.tsx');
    const footer = /function SheetFooter[\s\S]*?\n}\n/.exec(src)![0];
    expect(footer).not.toContain('env(');
  });
});

describe('the phone full-screen search sheet', () => {
  it('reserves the status bar with the sheet border, so its absolute Close button sits below it too', () => {
    mockPhone();
    render(
      <TooltipProvider>
        <AppShell topbar={<TopBarSearchSlot><input aria-label="Find" /></TopBarSearchSlot>} sidebar={<aside>Menu</aside>}>
          Page
        </AppShell>
      </TooltipProvider>,
    );
    act(() => screen.getByRole('button', { name: 'Search' }).click());
    const sheet = document.querySelector('[data-slot="sheet-content"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    const tokens = sheet.className.split(/\s+/);
    // An absolute child is placed from the padding box: padding would leave the Close button
    // under the clock and the Dynamic Island. The inset has to be a border (as every other sheet).
    expect(sheet.className).toContain('border-t-[length:env(safe-area-inset-top');
    expect(sheet.className).toContain('border-l-[length:env(safe-area-inset-left');
    expect(sheet.className).toContain('border-r-[length:env(safe-area-inset-right');
    expect(tokens).not.toContain('border-0');
    expect(tokens.some((t) => /^pt-\[env\(safe-area-inset-top/.test(t))).toBe(false);
    expect(padsBottom(sheet.className)).toBe(true);
  });
});

describe('pages that own the whole screen', () => {
  it('the sign-in, invite and public document roots use the safe-area padding utility', () => {
    for (const file of [
      'src/pages/v2/auth-public/LoginPage.tsx',
      'src/pages/v2/auth-public/AcceptInvitePage.tsx',
      'src/pages/v2/auth-public/components/publicShell.tsx',
    ]) {
      expect(read(file), file).toContain('pad-safe');
    }
    const css = read('src/index.css');
    const rule = /\.pad-safe\s*\{([^}]*)\}/.exec(css)![1];
    for (const edge of [TOP, RIGHT, BOTTOM, LEFT]) expect(rule).toContain(edge);
  });
});

describe('full-screen and bottom dialogs', () => {
  it('a full-screen dialog clears the notch sides, and its close button moves in with them', () => {
    mockPhone();
    render(
      <Dialog open>
        <DialogContent intent="form" aria-describedby={undefined}>
          <DialogTitle>New thing</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const content = document.querySelector('[data-presentation="fullscreen"]') as HTMLElement;
    expect(content.className).toContain(LEFT);
    expect(content.className).toContain(RIGHT);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.className).toContain(RIGHT);
  });
});

describe('the job, lead and invoice right rail', () => {
  // The rail is mounted by the job, lead and invoice detail pages from md up (below md its panel is a
  // sheet, slice 56). It follows the real top bar's bottom edge, so a notch-grown bar needs no inset
  // here; at right-0 it sat under the notch when the phone is held sideways, and unpadded it sat on
  // the home indicator.
  function renderRail() {
    mockViewport(false);
    renderWithProviders(<IconRail entityType="LEAD" entityId="lead-1"><div /></IconRail>);
    return { rail: screen.getByTestId('icon-rail'), panel: screen.getByTestId('icon-rail-panel') };
  }
  const tokens = (el: HTMLElement) => el.className.split(/\s+/);

  it('starts at the measured top bar edge, not at a fixed offset the notch outgrows', () => {
    const { rail, panel } = renderRail();
    for (const el of [rail, panel]) {
      expect(tokens(el).some((t) => t.startsWith('top-'))).toBe(false);
      expect(el.style.top).not.toBe('');
    }
  });

  it('keeps clear of the notch on its own edge and sits above the home indicator', () => {
    const { rail, panel } = renderRail();
    expect(tokens(rail).some((t) => t.startsWith('right-') && t.includes(RIGHT))).toBe(true);
    expect(tokens(panel).some((t) => t.startsWith('right-') && t.includes(RIGHT))).toBe(true);
    expect(rail.className).toContain(BOTTOM);
    expect(panel.className).toContain(BOTTOM);
  });

  it('closed, slides fully off screen, so no sliver of it shows in the notch zone', () => {
    const { panel } = renderRail();
    const closed = tokens(panel).find((t) => t.startsWith('translate-x-'))!;
    expect(closed).toContain(RIGHT);
  });

  it('never grows wider than the space left of the rail and the notch side', () => {
    const { panel } = renderRail();
    const width = tokens(panel).find((t) => t.startsWith('w-['))!;
    expect(width).toContain(RIGHT);
  });
});

/**
 * The guard that keeps it so: a `fixed` element anchored to the bottom edge sits on the home
 * indicator unless it pads for it. Heuristic on purpose (one literal that holds both `fixed` and a
 * `bottom-` anchor), so a new floating bar cannot ship without a decision.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx$/.test(name) && !/\.(test|stories)\./.test(name) ? [full] : [];
  });
}

/** A fixed bottom-anchored literal that is deliberately left as it is, and why. */
const GUARD_EXEMPT: Record<string, string> = {
  'components/copilot/': 'the copilot is left exactly as it is by decision; its button already pads for the safe area',
  'components/ui/toast.tsx': 'the retired toast viewport: the one toaster is sonner, which pads itself (sonner.tsx)',
  'ui-kit/components/ui/dialog.tsx': 'the bottom-sheet dialog: its footer pads for the home indicator (DialogFooter)',
  'components/communication/inbox/ComposeWindow.tsx': 'the docked compose window: its sticky footer holds Send and pads for the home indicator (data-slot=compose-footer)',
};

describe('--safe-bottom', () => {
  it('is the bottom inset, zeroed by the keyboard-open flag', () => {
    const css = read('src/index.css');
    const rule = /--safe-bottom:([^;]*);/.exec(css)![1];
    expect(rule).toContain(BOTTOM);
    expect(rule).toContain('--keyboard-open');
  });
});

describe('fixed bottom bars', () => {
  it('every fixed element anchored to the bottom edge pads for the home indicator', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (Object.keys(GUARD_EXEMPT).some((p) => rel.startsWith(p))) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\{?\/\*)/.test(line)) return;
        const quoted = /(["'`])((?:(?!\1).)*)\1/g;
        for (const m of line.matchAll(quoted)) {
          const lit = m[2];
          if (!/(^|\s)fixed(\s|$)/.test(lit)) continue;
          if (!/(^|\s|:)bottom-/.test(lit)) continue;
          if (!padsBottom(lit)) offenders.push(`${rel}:${i + 1}: ${lit.slice(0, 90)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
