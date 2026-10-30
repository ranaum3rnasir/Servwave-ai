/**
 * Payments W2: the Switch's OFF track and thumb must be visible against the card behind them
 * (WCAG 1.4.11 non-text contrast, 3:1), in light and dark. Colours are read from the real token
 * file and from the class the switch actually uses, so a token edit moves this test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contrastRatio } from '@/design-system/contrast';

const SRC = resolve(__dirname, '..');
const css = readFileSync(resolve(SRC, 'design-system/tokens-v2.css'), 'utf8');
const switchSrc = readFileSync(resolve(SRC, 'ui-kit/components/ui/switch.tsx'), 'utf8');

function block(selector: ':root' | '.dark'): string {
  const start = css.indexOf(`\n${selector} {`);
  const from = start === -1 ? css.indexOf(`${selector} {`) : start;
  return css.slice(from, css.indexOf('\n}', from));
}
function hex(selector: ':root' | '.dark', name: string): string {
  const m = new RegExp(`--${name}:\\s*(\\d+) (\\d+) (\\d+)`).exec(block(selector));
  if (!m) throw new Error(`token --${name} not found in ${selector}`);
  return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}
/** The token the switch paints its UNCHECKED track with: the first background class without a group modifier. */
function offTrackToken(): string {
  const m = /"([a-z]+-[a-z-]+) group-data-\[state=checked\]\/switch:/.exec(switchSrc);
  if (!m) throw new Error('could not find the off-track class in the ui-kit switch');
  return m[1]!.slice(m[1]!.indexOf('-') + 1); // drop the utility prefix, keep the token name
}

describe.each([
  [':root', 'light'],
  ['.dark', 'dark'],
] as const)('switch off state (%s = %s)', (sel) => {
  const track = () => hex(sel, offTrackToken());
  it('the off track reaches 3:1 against the card behind it', () => {
    expect(contrastRatio(track(), hex(sel, 'card'))).toBeGreaterThanOrEqual(3);
  });
  it('the white thumb reaches 3:1 against the off track', () => {
    expect(contrastRatio('#ffffff', track())).toBeGreaterThanOrEqual(3);
  });
});
