/* =============================================================================
   ServWave Design System — path alias guard (regression fence)
   -----------------------------------------------------------------------------
   Asserts the "@/*" import alias stays single-sourced across the three places
   that independently define it: tsconfig.json (editor/type-check resolution),
   vite.config.ts (dev server / build) and vitest.config.ts (test runner). If
   any of the three drifts from `./src`, imports resolve differently depending
   on which tool is running — a class of bug that is invisible until someone
   hits it in one tool but not another (invariant I5).
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(HERE, '..', '..', '..');

describe('path alias single-sourcing (I5)', () => {
  it('tsconfig.json, vite.config.ts and vitest.config.ts all point "@/*" at the same ./src target', () => {
    const tsconfig = readFileSync(resolve(FRONTEND_DIR, 'tsconfig.json'), 'utf8');
    const vite = readFileSync(resolve(FRONTEND_DIR, 'vite.config.ts'), 'utf8');
    const vitest = readFileSync(resolve(FRONTEND_DIR, 'vitest.config.ts'), 'utf8');

    const tsPathsMatch = tsconfig.match(/"@\/\*"\s*:\s*\[\s*"([^"]+)"\s*\]/);
    expect(tsPathsMatch, 'tsconfig.json must declare an "@/*" path').not.toBeNull();
    const tsTarget = tsPathsMatch![1]!.replace(/^\.\//, '').replace(/\/\*$/, '');
    expect(tsTarget).toBe('src');

    const configs: [string, string][] = [
      ['vite.config.ts', vite],
      ['vitest.config.ts', vitest],
    ];

    for (const [name, content] of configs) {
      const aliasMatch = content.match(/['"]@['"]\s*:\s*path\.resolve\(__dirname,\s*['"]([^'"]+)['"]\)/);
      expect(aliasMatch, `${name} must declare a '@' alias via path.resolve(__dirname, ...)`).not.toBeNull();
      const target = aliasMatch![1]!.replace(/^\.\//, '');
      expect(target).toBe('src');
    }
  });
});
