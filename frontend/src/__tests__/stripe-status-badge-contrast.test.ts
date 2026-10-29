/**
 * Mobile slice 75 (fixer round 2) - every state of the payments status badge meets AA contrast.
 *
 * The throwaway org the mobile gate provisions carries a fake connected account. The nightly
 * account-status refresh (07:30 UTC) answers for it with a processor error, fails closed, and the
 * org's badge moves from "Active" (green) to "Under review" (amber tint). The amber and the red
 * tints were `text-warning` on `bg-warning/10` (4.38:1) and `text-danger` on `bg-danger/10`
 * (4.19:1), so axe `color-contrast` failed `settings-payments` on every touch device for the rest
 * of any gate run that straddled the refresh. A real merchant in those states saw the same badge.
 *
 * jsdom cannot compute colour, so this reads the real token file and the card's real class
 * strings and does the WCAG arithmetic itself, for every tint the card can show.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const css = readFileSync(resolve(root, 'design-system/tokens.css'), 'utf8');
const card = readFileSync(resolve(root, 'components/payments/StripePaymentsStatusCard.tsx'), 'utf8');

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

/** A Tailwind colour utility (`warning`, `warning-text`, `warning/10`) as opaque channels over `under`. */
function resolveUtility(utility: string, under: Rgb): Rgb {
  const [name, alpha] = utility.split('/') as [string, string | undefined];
  const flat = name.replace(/^(.+)-(DEFAULT)$/, '$1');
  const rgb = token(flat);
  if (!alpha) return rgb;
  const a = Number(alpha) / 100;
  return rgb.map((c, i) => c * a + under[i]! * (1 - a)) as Rgb;
}

const WHITE: Rgb = [255, 255, 255]; // the Card the badge sits on

const tints = ['SUCCESS_TINT', 'WARNING_TINT', 'DANGER_TINT'].map((constName) => {
  const m = card.match(new RegExp(`const ${constName} = '([^']+)'`));
  if (!m) throw new Error(`${constName} not found in StripePaymentsStatusCard.tsx`);
  const classes = m[1]!.split(/\s+/);
  // The utility's name after its family prefix (`bg` or `text`, the part before the first dash).
  const named = (family: string) => {
    const c = classes.find((x) => x.split('-')[0] === family);
    return c ? c.slice(family.length + 1) : undefined;
  };
  const bg = named('bg');
  const text = named('text');
  if (!bg || !text) throw new Error(`${constName} needs a background and a text colour class: ${m[1]}`);
  return { constName, bg, text };
});

describe('payments status badge: every tint reads at 4.5:1', () => {
  it.each(tints)('$constName', ({ bg, text }) => {
    const fill = resolveUtility(bg, WHITE);
    expect(ratio(resolveUtility(text, fill), fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('the hover fill is the same fill (a hovered badge must not lose contrast)', () => {
    for (const { constName, bg } of tints) {
      const m = card.match(new RegExp(`const ${constName} = '([^']+)'`))!;
      expect(m[1], constName).toContain(`hover:${'bg'}-${bg}`);
    }
  });
});
