/**
 * The Skipped intent token (Roles & Permissions, PRD 6, S06.21): the red-ish colour a progress-bar step wears when the
 * job moved past it without reaching it. It has to read in the light and the dark theme, and colour is never the only
 * signal (the bar also writes "Skipped").
 *
 * jsdom cannot compute colour, so this reads the real token files and does the WCAG arithmetic itself, the way the
 * status menu tooltip contrast test does. The pairs are the ones the bar paints: the label text on the card behind it,
 * the label text on the step's own tint, and the step's ring against the card.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../contrast';

const root = resolve(__dirname, '../../..');
const v2 = readFileSync(resolve(root, 'src/design-system/tokens-v2.css'), 'utf8');
const legacy = readFileSync(resolve(root, 'src/design-system/tokens.css'), 'utf8');
const tailwind = readFileSync(resolve(root, 'tailwind.config.js'), 'utf8');

const darkBlock = v2.slice(v2.indexOf('\n.dark {'), v2.indexOf('\n}', v2.indexOf('\n.dark {')));
const lightBlock = v2.slice(v2.indexOf(':root'), v2.indexOf('\n}', v2.indexOf(':root')));

/** `--name` as a hex colour for a theme, following var() aliases; the dark block's own value wins in the dark theme. */
function resolveHex(name: string, dark: boolean): string {
  const find = (css: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  const m = (dark && find(darkBlock)) || find(lightBlock) || find(legacy);
  if (!m) throw new Error(`token --${name} not found`);
  const value = (m[1] ?? '').trim();
  const alias = value.match(/^var\(--([a-z0-9-]+)\)/);
  if (alias) return resolveHex(alias[1] ?? '', dark);
  const rgb = value.match(/^(\d+)\s+(\d+)\s+(\d+)/);
  if (!rgb) throw new Error(`token --${name} is not an rgb triple: ${value}`);
  return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
}

describe.each([false, true])('the Skipped token (dark=%s)', (dark) => {
  const card = () => resolveHex('card', dark);

  it('is declared in this theme, text, tint and ring', () => {
    const block = dark ? darkBlock : lightBlock;
    for (const name of ['skipped', 'skipped-surface', 'skipped-text']) {
      expect(block, `--${name}`).toMatch(new RegExp(`--${name}:\\s*\\d+\\s+\\d+\\s+\\d+`));
    }
  });

  it('the label text reads at 4.5:1 on the card behind the bar', () => {
    expect(contrastRatio(resolveHex('skipped-text', dark), card())).toBeGreaterThanOrEqual(4.5);
  });

  it('the label text reads at 4.5:1 on the step\'s own tint', () => {
    expect(contrastRatio(resolveHex('skipped-text', dark), resolveHex('skipped-surface', dark))).toBeGreaterThanOrEqual(4.5);
  });

  it('the ring reads at 3:1 against the card, as a control outline must', () => {
    expect(contrastRatio(resolveHex('skipped', dark), card())).toBeGreaterThanOrEqual(3);
  });
});

describe('the Skipped token in the Tailwind config', () => {
  it('mints the colours the bar uses from the three tokens', () => {
    const block = tailwind.slice(tailwind.indexOf('skipped: {'), tailwind.indexOf('}', tailwind.indexOf('skipped: {')));
    expect(block).toContain("DEFAULT: 'rgb(var(--skipped) / <alpha-value>)'");
    expect(block).toContain("surface: 'rgb(var(--skipped-surface) / <alpha-value>)'");
    expect(block).toContain("text: 'rgb(var(--skipped-text) / <alpha-value>)'");
  });
});
