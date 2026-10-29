/**
 * Mobile slice 34 (VP-04, SCR-01): the frame rules live in shell.css, which jsdom cannot lay out, so
 * this reads the source. The real-browser check is e2e/mobile/page-frame.spec.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '..', 'components', 'layout', 'shell.css'), 'utf8');
const rule = (selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} rule exists`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('\n}', start));
};

describe('shell frame css', () => {
  it('sizes the frame to the dynamic viewport, with 100vh only as the fallback before it', () => {
    const app = rule('.app');
    const vh = app.indexOf('height: 100vh;');
    const dvh = app.indexOf('height: 100dvh;');
    expect(dvh, '.app declares height: 100dvh').toBeGreaterThan(-1);
    expect(vh, 'the 100vh fallback comes first so the dvh declaration wins').toBeGreaterThan(-1);
    expect(vh).toBeLessThan(dvh);
  });

  it('contains overscroll on the one page scroller', () => {
    expect(rule('.canvas-body')).toMatch(/overscroll-behavior:\s*contain;/);
  });
});
