// Mobile slice 13: ONE breakpoint source.
//
// Tailwind's screens (the CSS side) and the JavaScript media-query hook (the side that decides what
// MOUNTS: drawers, sheets, overflow menus) must read the same numbers, or there is a band of widths
// where the CSS lays out one shell and the JavaScript renders another. That band existed: the shell
// drew its drawer below 761 px while the mobile hook said "phone" below 768 px.
//
// This file pins:
//   - tailwind.config.js takes its screens from the shared module (same values as Tailwind's stock
//     screens, so no utility changes);
//   - the shell components carry no pixel breakpoint of their own;
//   - every media query in the shell's stylesheet is one of the named queries, verbatim.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import tailwindConfig from '../../tailwind.config.js';
import { MEDIA, SCREENS, SHORT_HEIGHT_MAX } from '@/ui-kit/lib/breakpoints';

const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

/** Shell-layout sources that used to branch on a pixel width of their own. */
const SHELL_SOURCES = [
  'ui-kit/components/layout/appShell.tsx',
  'ui-kit/components/layout/nav/topBar.tsx',
  'pages/v2/V2AppLayout.tsx',
  'components/notifications/NotificationBell.tsx',
  'pages/v2/schedule/creation/scheduleCreatePopover.tsx',
  'hooks/useIsMobile.ts',
];

describe('one breakpoint source', () => {
  it('names Tailwind\'s stock screens and one short-height condition', () => {
    expect(SCREENS).toEqual({ sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 });
    expect(SHORT_HEIGHT_MAX).toBe(500);
    expect(MEDIA).toMatchObject({
      belowSm: '(max-width: 639.98px)',
      belowMd: '(max-width: 767.98px)',
      belowLg: '(max-width: 1023.98px)',
      belowXl: '(max-width: 1279.98px)',
      sm: '(min-width: 640px)',
      md: '(min-width: 768px)',
      lg: '(min-width: 1024px)',
      xl: '(min-width: 1280px)',
      shortHeight: '(max-height: 500px)',
    });
  });

  it('feeds tailwind.config.js its screens from the same module', () => {
    const screens = (tailwindConfig as { theme: { screens?: Record<string, string> } }).theme.screens;
    expect(screens).toEqual(Object.fromEntries(Object.entries(SCREENS).map(([k, v]) => [k, `${v}px`])));
    // Read from the module, not retyped: a literal copy would drift silently.
    expect(readFileSync(join(process.cwd(), 'tailwind.config.js'), 'utf8')).toMatch(/from ['"]\.\/src\/ui-kit\/lib\/breakpoints\.js['"]/);
  });

  for (const file of SHELL_SOURCES) {
    it(`${file} hard-codes no pixel breakpoint`, () => {
      const code = src(file);
      expect(code).not.toMatch(/\((?:max|min)-(?:width|height):\s*\d/);
      expect(code).not.toMatch(/innerWidth\s*[<>]=?/);
      expect(code).not.toMatch(/navigator\.userAgent/);
    });
  }

  it('uses only the named queries in the shell stylesheet', () => {
    const css = src('ui-kit/components/layout/shell.css');
    const named = new Set<string>(Object.values(MEDIA));
    const queries = [...css.matchAll(/@media\s+([^{]+)\{/g)].map((m) => m[1]!.trim());
    const widthQueries = queries.filter((q) => /(?:max|min)-(?:width|height)/.test(q));
    expect(widthQueries.length).toBeGreaterThan(0);
    for (const q of widthQueries) expect(named, `@media ${q}`).toContain(q);
  });
});
