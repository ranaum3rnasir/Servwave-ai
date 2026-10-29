/**
 * Mobile slice 75 (staging fix 1) - the dashboard's red and green pills meet AA contrast on real data.
 *
 * The gate's throwaway org has no past-due money and no falling trend, so the dashboard's red
 * delta chip (TrendDelta, danger tone), the "past due" pill and the Needs Attention badge never
 * rendered there. On the demo org axe measured them at 4.19:1 (`text-danger` on `bg-danger/10`,
 * 11 to 12 px). They use the design system's danger surface and text pair, as the payments
 * badge does (see stripe-status-badge-contrast.test.ts, whose arithmetic this repeats).
 *
 * jsdom cannot compute colour, so this reads the real token file and the components' real class
 * strings and does the WCAG arithmetic itself.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const css = read('design-system/tokens.css');
const trend = read('components/data/TrendDelta.tsx');
const registry = read('components/dashboard/widgetRegistry.tsx');
const attention = read('components/dashboard/widgets/NeedsAttention.tsx');

type Rgb = [number, number, number];

/** `--name: r g b` or `--name: var(--other)`, resolved to channels. */
function token(name: string): Rgb {
  const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} not found`);
  const v = m[1]!.trim();
  const ref = v.match(/^var\(--([a-z0-9-]+)\)/);
  if (ref) return token(ref[1]!);
  const ch = v.match(/^(\d+)\s+(\d+)\s+(\d+)/);
  if (!ch) throw new Error(`token --${name} is not a colour: ${v}`);
  return [Number(ch[1]), Number(ch[2]), Number(ch[3])];
}

const lum = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** A Tailwind colour utility (`danger-text`, `danger/10`) as opaque channels over `under`. */
function resolveUtility(utility: string, under: Rgb): Rgb {
  const [name, alpha] = utility.split('/') as [string, string | undefined];
  const rgb = token(name.replace(/^(.+)-(DEFAULT)$/, '$1'));
  if (!alpha) return rgb;
  const a = Number(alpha) / 100;
  return rgb.map((c, i) => c * a + under[i]! * (1 - a)) as Rgb;
}

const WHITE: Rgb = [255, 255, 255]; // the dashboard card the pills sit on

/** The background and text colour utilities of a class string. */
function pair(classes: string) {
  const list = classes.split(/\s+/);
  const pick = (family: string) => list.find((x) => x.split('-')[0] === family)?.slice(family.length + 1);
  const bg = pick('bg');
  const text = pick('text');
  if (!bg || !text) throw new Error(`needs a bg and a text class: ${classes}`);
  return { bg, text };
}

const attentionDanger = (() => {
  const row = attention.match(/danger: \{[^}]*\}/)?.[0] ?? '';
  const bg = row.match(/badgeBg: '([^']+)'/)?.[1];
  const text = row.match(/badgeText: '([^']+)'/)?.[1];
  return bg && text ? `${bg} ${text}` : undefined;
})();

const cases = [
  { name: 'TrendDelta danger tone', classes: trend.match(/resolvedTone === 'success' \? '[^']+' : '([^']+)'/)?.[1] },
  { name: 'TrendDelta success tone', classes: trend.match(/resolvedTone === 'success' \? '([^']+)'/)?.[1] },
  { name: 'past-due pill', classes: registry.match(/past due`, '([^']+)'/)?.[1] },
  { name: 'Needs Attention danger badge', classes: attentionDanger },
];

describe('dashboard red and green pills read at 4.5:1', () => {
  it.each(cases)('$name', ({ classes }) => {
    expect(classes, 'class string not found in source').toBeTruthy();
    const { bg, text } = pair(classes!);
    const fill = resolveUtility(bg, WHITE);
    expect(ratio(resolveUtility(text, fill), fill)).toBeGreaterThanOrEqual(4.5);
  });
});
