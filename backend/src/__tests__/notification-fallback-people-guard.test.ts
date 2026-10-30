/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.24 - the access filter inside a call or text alert has ONE exception: the never-silent
   fallback, which tells the holders of Manage roles and permissions that nobody else would be told about (conversationAlertFallback.ts).

   `emit` skips the lookup of the conversation's people, and the filter in it, only for a `FallbackPeople` token that module made.
   Two guards keep it that way:
     1. the token is real: a look-alike object does not pass `isFallbackPeople`;
     2. no source file but the fallback and the two that hand it over (the alert writer) names `fallbackPeople`, `FallbackPeople` or
        `isFallbackPeople`, so no other path can pass or mint one.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isFallbackPeople } from '../services/notifications/conversationAlertFallback';

const SRC = join(__dirname, '..');

/** The files that may name the token, and why. */
const MAY_NAME_THE_TOKEN: Record<string, string> = {
  'services/notifications/conversationAlertFallback.ts': 'makes the token and checks it',
  'services/notifications/notificationService.ts': 'carries it on EmitArgs, accepts it from the fallback and passes it on',
};

const sourceFilesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFilesUnder(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });

/** The files (by path under src) whose code names the token. Words in a comment are not code. */
export function filesNamingTheToken(files: Array<{ path: string; text: string }>): string[] {
  return files
    .filter((f) => f.text.split('\n').some((line) => /\b(isFallbackPeople|FallbackPeople|fallbackPeople)\b/.test(line.replace(/\/\/.*$/, '').replace(/^\s*(\*|\/\*).*$/, ''))))
    .map((f) => f.path);
}

describe('the fallback token that lets an alert skip the access filter', () => {
  it('is not satisfied by an object that only looks like one', () => {
    expect(isFallbackPeople({ ids: ['someone'] })).toBe(false);
    expect(isFallbackPeople(undefined)).toBe(false);
    expect(isFallbackPeople(null)).toBe(false);
    expect(isFallbackPeople(['someone'])).toBe(false);
  });

  it('flags a file that names it (the scan can fail)', () => {
    expect(filesNamingTheToken([{ path: 'x.ts', text: 'await emit({ ...args, fallbackPeople: { ids } });' }])).toEqual(['x.ts']);
    expect(filesNamingTheToken([{ path: 'y.ts', text: '// fallbackPeople is only for the fallback\n * FallbackPeople' }])).toEqual([]);
  });

  it('is named by no source file but the fallback and the alert writer', () => {
    const files = sourceFilesUnder(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }));
    expect(files.length).toBeGreaterThan(100);
    expect(filesNamingTheToken(files).sort()).toEqual(Object.keys(MAY_NAME_THE_TOKEN).sort());
  });
});
