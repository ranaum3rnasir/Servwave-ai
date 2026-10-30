import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// PRD Module 1 (payments go-live): a connected account's controller settings are fixed at
// creation, so "no code path may create an account with any other controller setting".
// createConnectedAccount in lib/stripe.ts is the ONE place that calls the processor's
// account-create endpoint, and it takes no controller/capability parameter. This guard
// fails the moment a second call site appears anywhere in backend source or scripts.

const BACKEND_ROOT = resolve(__dirname, '../..');
const SCANNED_DIRS = ['src', 'scripts'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '__tests__']);
const ACCOUNT_CREATE_CALL = /\.accounts\s*\.\s*create\s*\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : sourceFiles(full);
    return /\.(ts|mts|js|mjs)$/.test(name) ? [full] : [];
  });
}

describe('connected account creation path', () => {
  it('only lib/stripe.ts calls the processor account-create endpoint', () => {
    const callers = SCANNED_DIRS
      .flatMap((d) => sourceFiles(join(BACKEND_ROOT, d)))
      .filter((file) => ACCOUNT_CREATE_CALL.test(readFileSync(file, 'utf8')))
      .map((file) => relative(BACKEND_ROOT, file));

    expect(callers).toEqual(['src/lib/stripe.ts']);
  });
});
