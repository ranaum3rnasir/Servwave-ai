/**
 * Mobile slice F28a - the public estimate's Decline dialog meets AA colour contrast.
 *
 * The gate (axe, color-contrast) flagged the solid destructive button (white on #e2445c = 4.03:1)
 * and the Select placeholder (subtle-foreground = 2.96:1 light, 4.31:1 dark). jsdom cannot compute
 * colour, so this reads the real token file and the real component class strings and does the WCAG
 * arithmetic itself. Both assertions fail against the pre-fix tokens/classes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const css = readFileSync(resolve(root, 'design-system/tokens-v2.css'), 'utf8');
const button = readFileSync(resolve(root, 'ui-kit/components/ui/button.tsx'), 'utf8');
const select = readFileSync(resolve(root, 'ui-kit/components/ui/select.tsx'), 'utf8');

const block = (selector: ':root' | '.dark') => {
  const start = css.indexOf(`\n${selector} {`);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
};
const token = (scope: string, name: string): [number, number, number] => {
  const m = scope.match(new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`));
  if (!m) throw new Error(`token --${name} not found`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const lum = (rgb: number[]) => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe.each([':root', '.dark'] as const)('contrast in %s', (selector) => {
  const scope = block(selector);

  it('the solid destructive button fill carries its white label at 4.5:1', () => {
    expect(button).toContain('bg-destructive-solid');
    expect(ratio(token(scope, 'destructive-solid'), token(scope, 'destructive-foreground'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token(scope, 'destructive-solid-hover'), token(scope, 'destructive-foreground'))).toBeGreaterThanOrEqual(4.5);
  });

  it('the Select placeholder colour reads at 4.5:1 on the card', () => {
    const m = select.match(/data-\[placeholder\]:text-([a-z-]+)/);
    expect(m).not.toBeNull();
    const name = m![1];
    expect(ratio(token(scope, name), token(scope, 'card'))).toBeGreaterThanOrEqual(4.5);
  });
});
