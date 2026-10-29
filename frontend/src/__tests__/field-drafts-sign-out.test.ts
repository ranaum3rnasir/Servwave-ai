/**
 * Mobile slice 57: which sign-outs purge drafts.
 *
 * A USER-initiated sign-out (`logout()`: the Sign Out button) clears that user's drafts, because a
 * draft holds customer details and the person has said they are done on this device. A FORCED
 * sign-out must NOT: a failed session check (`checkAuth` catching a 401), the API interceptor's
 * 401 handler and the cross-tab SIGNED_OUT event all fire exactly when someone has just lost the
 * session under half a note, and the draft is what lets them sign back in and carry on. That is
 * the #2377 path (a failed session check signs the user out), so it is pinned here.
 *
 * Runs the REAL auth store (the global setup mock replaces it with a selector stub).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.unmock('@/stores/auth.store');

import api from '@/lib/axios';
import { supabase } from '@/lib/supabase';
import { draftStorageKey, readDraft, writeDraft } from '@/lib/drafts/fieldDraftStore';

const mockApi = vi.mocked(api);

const ORG = 'org-aaaa';
const ME = { id: 'user-me', email: 'me@example.com', organization_id: ORG };
const SOMEONE_ELSE = 'user-else';

const keyOf = (userId: string, recordId = 'job-1') =>
  draftStorageKey({ organizationId: ORG, userId, recordType: 'JOB', recordId, field: 'note' });

async function loadStore() {
  vi.resetModules();
  // Re-import the draft store from the same module graph the auth store will use.
  const [store, drafts] = await Promise.all([
    import('@/stores/auth.store'),
    import('@/lib/drafts/fieldDraftStore'),
  ]);
  return { useAuthStore: store.useAuthStore, drafts };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null } as never);
  // The store reads its cached user at import time: this is "someone signed in".
  localStorage.setItem('servwave_user', JSON.stringify(ME));
  writeDraft(keyOf(ME.id), 'my half-written note');
  writeDraft(keyOf(ME.id, 'job-2'), 'another of mine');
  writeDraft(keyOf(SOMEONE_ELSE), "someone else's note");
});

describe('a user-initiated sign-out', () => {
  it("clears that user's drafts and leaves other users' drafts alone", async () => {
    const { useAuthStore, drafts } = await loadStore();
    mockApi.post.mockResolvedValue({ data: {} });

    await useAuthStore.getState().logout();

    expect(drafts.readDraft(keyOf(ME.id))).toBeNull();
    expect(drafts.readDraft(keyOf(ME.id, 'job-2'))).toBeNull();
    expect(drafts.readDraft(keyOf(SOMEONE_ELSE))).toBe("someone else's note");
  });

  it('clears them even when the logout API call fails', async () => {
    const { useAuthStore, drafts } = await loadStore();
    mockApi.post.mockRejectedValue(new Error('network'));

    await useAuthStore.getState().logout();

    expect(drafts.readDraft(keyOf(ME.id))).toBeNull();
  });
});

describe('a forced sign-out keeps the drafts', () => {
  it('a failed session check (checkAuth catching an error) does NOT purge', async () => {
    const { useAuthStore, drafts } = await loadStore();
    mockApi.get.mockRejectedValue(Object.assign(new Error('unauthorized'), { response: { status: 401 } }));

    await useAuthStore.getState().checkAuth();

    // It did sign the user out ...
    expect(supabase.auth.signOut).toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    // ... and left what they had typed.
    expect(drafts.readDraft(keyOf(ME.id))).toBe('my half-written note');
    expect(drafts.readDraft(keyOf(ME.id, 'job-2'))).toBe('another of mine');
  });

  it('the cross-tab / interceptor SIGNED_OUT event does NOT purge', async () => {
    vi.resetModules();
    let handler: ((event: string, session: unknown) => void) | undefined;
    (supabase.auth as unknown as { onAuthStateChange: unknown }).onAuthStateChange = vi.fn(
      (cb: (event: string, session: unknown) => void) => {
        handler = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    );
    const [{ initAuthListener }, drafts] = await Promise.all([
      import('@/lib/auth-listener'),
      import('@/lib/drafts/fieldDraftStore'),
    ]);
    initAuthListener();

    handler?.('SIGNED_OUT', null);

    expect(handler).toBeDefined();
    expect(drafts.readDraft(keyOf(ME.id))).toBe('my half-written note');
  });
});

describe('the helper the tests above rely on', () => {
  it('readDraft sees what writeDraft wrote (guards against a vacuous "still there" check)', () => {
    expect(readDraft(keyOf(ME.id))).toBe('my half-written note');
  });
});
