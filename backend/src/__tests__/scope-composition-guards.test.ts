/**
 * Two guards around the row-scope machinery, both written after review found real bugs of the exact
 * shapes below.
 *
 * 1. THE OR-CLOBBER SWEEP. A grant-driven scope fragment is spread into a controller's `where`. If
 *    that same object literal also assigns its own `OR:` for search terms, the later key wins and
 *    the scope is silently deleted - the requester sees every row in the org. It is invisible in
 *    review because it looks like two unrelated lines, and it stays dormant until some role's
 *    fragment happens to BE an `{ OR: [...] }`: the technician-ownership spec (Part C) widened
 *    `read Job` to assigned-OR-created and turned a dormant instance in
 *    comm-calls.controller.ts's dialer search into a live leak of every job in the org.
 *    `lib/permissions/whereCompose.ts`'s addOrFilter exists for this; this test makes sure nobody
 *    hand-rolls it again.
 *
 * 2. THE canActOnRow FAST PATH. Documented in its own docblock as NOT a tenancy check, and worth a
 *    test rather than a comment, because the failure is a cross-org read.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { canActOnRow } from '../lib/permissions/enforce';
import { TEST_USERS, ALPHA_ORG_ID } from './helpers';

// ── 1. no scope fragment is spread beside a literal OR ──────────────────────────────────────────

const SRC = join(__dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The top-level keys of the object literal enclosing `index`, nested braces removed. */
function enclosingLiteralKeys(src: string, index: number): string {
  let depth = 0;
  let i = index;
  while (i > 0) {
    if (src[i] === '}') depth += 1;
    else if (src[i] === '{') {
      if (depth === 0) break;
      depth -= 1;
    }
    i -= 1;
  }
  let j = index;
  depth = 0;
  while (j < src.length) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      if (depth === 0) break;
      depth -= 1;
    }
    j += 1;
  }
  const body = src.slice(i + 1, j);
  let d = 0;
  let top = '';
  for (const ch of body) {
    if (ch === '{' || ch === '[') d += 1;
    else if (ch === '}' || ch === ']') d -= 1;
    else if (d === 0) top += ch;
  }
  return top;
}

describe('no controller spreads a row-scope fragment beside a literal OR', () => {
  it('finds no hand-rolled clobber (use addOrFilter instead)', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\.\.\.\s*(\w*[Ss]cope\w*)\b/g)) {
        if (/\bOR\s*:/.test(enclosingLiteralKeys(src, m.index!))) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${file.replace(SRC, 'src')}:${line} (spread of ${m[1]})`);
        }
      }
    }
    expect(
      offenders,
      `row scope spread beside a literal OR - the OR wins and the scope is silently dropped. ` +
        `Use addOrFilter (lib/permissions/whereCompose.ts):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

// ── 2. canActOnRow's documented fast path ───────────────────────────────────────────────────────

describe('canActOnRow - the all-unconditional fast path', () => {
  const req = (role: string) =>
    ({ user: { ...TEST_USERS.admin, role, organization_id: ALPHA_ORG_ID } }) as never;

  it('returns true WITHOUT querying when neither fragment restricts - so it is NOT a tenancy check', async () => {
    // ADMIN short-circuits both halves. The delegate must never be touched, which is exactly why a
    // controller cannot lean on this for cross-org safety: an id from ANOTHER organization passes.
    // The caveat is in the docblock; this is the test that keeps it true.
    const findFirst = vi.fn();
    await expect(
      canActOnRow(req('ADMIN'), 'Job', { findFirst, count: vi.fn() }, 'any-id-at-all', 'delete'),
    ).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('denies with no user attached, rather than falling through to the fast path', async () => {
    const findFirst = vi.fn();
    await expect(
      canActOnRow({} as never, 'Job', { findFirst, count: vi.fn() }, 'any-id-at-all', 'delete'),
    ).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
