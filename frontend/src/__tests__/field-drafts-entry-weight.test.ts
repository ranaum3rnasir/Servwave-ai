/**
 * Mobile slice 66 (staging fix): the staff entry carries only what a sign-out needs of the draft
 * store.
 *
 * The auth store is in the staff app's initial JavaScript, which has a gzipped ceiling the build
 * enforces (scripts/check-public-bundle-budget.mjs). It used to import `clearUserDrafts` from
 * `fieldDraftStore`, which put the whole draft store (read, write, expiry sweep, key builder) in the
 * entry although only the field-draft hook, in a lazy chunk, uses them. Slice 66 tipped the entry
 * over the ceiling by 61 bytes and the staging build failed. The sign-out half now lives in its own
 * small module, and the entry imports only that.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = resolve(__dirname, '..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');
const importsOf = (source: string) =>
  [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

describe('the staff entry and the draft store', () => {
  it('the auth store imports the sign-out half, not the whole draft store', () => {
    const imports = importsOf(read('stores/auth.store.ts'));
    expect(imports).toContain('@/lib/drafts/draftSignOut');
    expect(imports).not.toContain('@/lib/drafts/fieldDraftStore');
  });

  it('the sign-out half does not import the draft store back', () => {
    const imports = importsOf(read('lib/drafts/draftSignOut.ts'));
    expect(imports.filter((i) => i.includes('fieldDraftStore'))).toEqual([]);
  });
});

describe('clearUserDrafts from the sign-out half', () => {
  beforeEach(() => localStorage.clear());

  it('clears one user\'s drafts in storage and leaves another user\'s', async () => {
    const { clearUserDrafts } = await import('@/lib/drafts/draftSignOut');
    const { draftStorageKey, readDraft, writeDraft } = await import('@/lib/drafts/fieldDraftStore');
    const key = (userId: string) =>
      draftStorageKey({ organizationId: 'org-1', userId, recordType: 'JOB', recordId: 'j1', field: 'note' });
    writeDraft(key('me'), 'mine');
    writeDraft(key('else'), 'theirs');

    clearUserDrafts('org-1', 'me');

    expect(readDraft(key('me'))).toBeNull();
    expect(readDraft(key('else'))).toBe('theirs');
  });

  it('is the same function the draft store re-exports', async () => {
    const core = await import('@/lib/drafts/draftSignOut');
    const store = await import('@/lib/drafts/fieldDraftStore');
    expect(store.clearUserDrafts).toBe(core.clearUserDrafts);
  });
});
