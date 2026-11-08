/**
 * StatusMenu tooltip: both lines read at 4.5:1 in the light AND the dark theme (walkthrough
 * lead-statuses PRD 7.4 tooltip, 12.6 dark themes; QA scenario D03).
 *
 * jsdom cannot compute colour, so this reads the real token files and the real class strings and
 * does the WCAG arithmetic itself. The tooltip panel uses the legacy `bg-surface-light
 * text-text-primary` pair, which does NOT flip under `.dark` (tokens.css has no dark block), so
 * the reason line must not use a v2 token that does flip (`text-muted-foreground`), or it turns
 * pale grey on a white panel.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(__dirname, '../../../..');
const legacy = readFileSync(resolve(src, 'design-system/tokens.css'), 'utf8');
const v2 = readFileSync(resolve(src, 'design-system/tokens-v2.css'), 'utf8');
const menu = readFileSync(resolve(__dirname, '../statusMenu.tsx'), 'utf8');
const tooltip = readFileSync(resolve(src, 'components/ui/tooltip.tsx'), 'utf8');

const darkBlock = v2.slice(v2.indexOf('\n.dark {'), v2.indexOf('\n}', v2.indexOf('\n.dark {')));

/** Resolve `--name` to an rgb triple, following var() aliases; `.dark` overrides win when dark. */
function resolveToken(name: string, dark: boolean): number[] {
  const find = (css: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  const m = (dark && find(darkBlock)) || find(v2) || find(legacy);
  if (!m) throw new Error(`token --${name} not found`);
  const value = (m[1] ?? '').trim();
  const alias = value.match(/^var\(--([a-z0-9-]+)\)/);
  if (alias) return resolveToken(alias[1] ?? '', dark);
  const rgb = value.match(/^(\d+)\s+(\d+)\s+(\d+)/);
  if (!rgb) throw new Error(`token --${name} is not an rgb triple: ${value}`);
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
}
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]: number[]) => 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
const ratio = (a: number[], b: number[]) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** The class tokens applied to the JSX element whose children are `{reason}`. */
const reasonColour = () => {
  const m = menu.match(/<p className="([^"]*)">\{reason\}<\/p>/);
  if (!m) throw new Error('reason line not found in statusMenu.tsx');
  // Token name after the colour-utility prefix, or null when no colour class is set.
  return (m[1] ?? '').match(/(?:^|\s)text-(\S+)/)?.[1] ?? null;
};
const panelBg = () => tooltip.match(/\bbg-([a-z-]+)\b/)?.[1] ?? 'missing-bg';
const panelText = () => tooltip.match(/\btext-(text-primary)\b/)?.[1] ?? 'missing-text';

describe.each([false, true])('StatusMenu tooltip contrast (dark=%s)', (dark) => {
  it('the meaning line (panel text colour) reads at 4.5:1 on the panel', () => {
    expect(ratio(resolveToken(panelText(), dark), resolveToken(panelBg(), dark))).toBeGreaterThanOrEqual(4.5);
  });

  it('the lock-reason line reads at 4.5:1 on the panel', () => {
    const colour = reasonColour();
    // No colour class = it inherits the panel text colour, which the test above covers.
    const fg = colour ? resolveToken(colour, dark) : resolveToken(panelText(), dark);
    expect(ratio(fg, resolveToken(panelBg(), dark))).toBeGreaterThanOrEqual(4.5);
  });
});
