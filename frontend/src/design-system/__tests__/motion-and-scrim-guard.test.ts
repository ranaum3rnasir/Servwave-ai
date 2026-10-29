/**
 * Mobile slice 16 guard: reduced motion reaches every overlay, and no scrim blurs on a phone.
 *
 * The browser-level proof is the mobile gate (e2e/mobile/overlay-motion.spec.ts measures the
 * computed animation, transition and backdrop filter of real overlays on six devices, and the
 * gate's `scrimBlur` check runs on every key route). CI runs Vitest only, so this file keeps the
 * three source-level decisions from quietly coming undone:
 *
 *  1. The reduced-motion rule is global. It used to sit under `.app *` in shell.css, and every
 *     dialog, sheet, popover and toast portals to <body>, outside `.app`, so none of them obeyed it.
 *  2. The app root sets framer-motion to follow the OS setting (only the dashboard did).
 *  3. A full-viewport scrim blurs only where the pointer is fine and can hover (a desktop): a
 *     3 px backdrop blur over the whole screen is a GPU cost a phone pays on every frame of a sheet
 *     drag, for a frosted look nobody can see under a finger.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** The CSS blocks under each `@media (prefers-reduced-motion: reduce)` in a stylesheet. */
function reducedMotionBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' || name === 'copilot' ? [] : walk(p);
    return /\.(tsx?|css)$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('reduced motion reaches the portalled overlays', () => {
  it('index.css carries a GLOBAL reduced-motion rule (every element, not only those inside .app)', () => {
    const blocks = reducedMotionBlocks(read('index.css'));
    const global = blocks.find((b) => /(^|[\s,}])\*\s*,\s*\*::before\s*,\s*\*::after\s*\{/.test(b));
    expect(global, 'no `*, *::before, *::after` rule under prefers-reduced-motion in index.css').toBeDefined();
    expect(global).toMatch(/animation[^;]*:\s*none\s*!important|animation-duration\s*:\s*0\.01ms\s*!important/);
    expect(global).toMatch(/transition[^;]*:\s*none\s*!important|transition-duration\s*:\s*0\.01ms\s*!important/);
  });

  it('the app root sets framer-motion to follow the OS reduced-motion setting', () => {
    const app = read('App.tsx');
    expect(app).toMatch(/import\s*\{[^}]*\bMotionConfig\b[^}]*\}\s*from\s*'framer-motion'/);
    expect(app).toMatch(/<MotionConfig\s+reducedMotion="user"\s*>/);
  });
});

describe('no full-viewport scrim blurs on a touch screen', () => {
  // A line that paints a viewport-covering layer (`fixed inset-0`) and a backdrop blur.
  const SCRIM_WITH_BLUR = /fixed inset-0[^"'`]*backdrop-blur|backdrop-blur[^"'`]*fixed inset-0/;

  it('every scrim blur is behind the fine-pointer variant', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!SCRIM_WITH_BLUR.test(line)) return;
        // Every backdrop-blur token on the line must carry the `pointer-fine:` variant.
        const bare = line.match(/(?<![\w:-])backdrop-blur(-[\w[\]./]+)?/g);
        if (bare) offenders.push(`${relative(SRC, file)}:${i + 1}: ${bare.join(' ')}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the dialog and sheet overlays still blur on a fine pointer (the desktop look is kept)', () => {
    for (const rel of ['components/ui/dialog.tsx', 'ui-kit/components/ui/dialog.tsx', 'ui-kit/components/ui/sheet.tsx']) {
      expect(read(rel), rel).toMatch(/pointer-fine:backdrop-blur-\[3px\]/);
    }
  });

  it('tailwind defines the pointer-fine variant the scrims use', () => {
    const config = readFileSync(join(SRC, '..', 'tailwind.config.js'), 'utf8');
    // The variant rides the interactionPolicy plugin's CAN_HOVER constant: assert both halves.
    expect(config).toMatch(/const CAN_HOVER = '@media \(hover: hover\) and \(pointer: fine\)'/);
    expect(config).toMatch(/addVariant\(\s*'pointer-fine'\s*,\s*CAN_HOVER\s*\)/);
  });
});
