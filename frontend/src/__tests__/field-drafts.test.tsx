/**
 * Mobile slice 57: one draft hook keeps free text typed in the field until it is saved.
 *
 * Pins the hook and the store beneath it (the surfaces have their own file): save (debounced),
 * the immediate flush when the page is hidden / frozen / the field unmounts, restore with the
 * restored flag, clear on save, the 7-day expiry, keying by organisation and user, the in-memory
 * fallback when storage throws, and the unsaved-work signal while a draft exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useAuthStore, type User } from '@/stores/auth.store';
import { hasUnsavedWork } from '@/ui-kit/lib/unsavedWork';
import {
  DRAFT_TTL_MS,
  clearUserDrafts,
  draftStorageKey,
  readDraft,
  removeDraft,
  writeDraft,
} from '@/lib/drafts/fieldDraftStore';
import { DRAFT_DEBOUNCE_MS, useFieldDraft } from '@/lib/drafts/useFieldDraft';

const ORG = 'org-aaaa';
const USER_A = 'user-aaaa';
const USER_B = 'user-bbbb';

// The global setup replaces the auth store with a selector stub: point it at whoever "signs in".
function setUser(user: Partial<User> | null) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: unknown) => unknown) =>
    selector({ user, isAuthenticated: !!user })) as never);
}

function signIn(id: string, organization_id = ORG) {
  setUser({ id, organization_id });
}

const NOTE = { recordType: 'JOB', recordId: 'job-1', field: 'note' } as const;

function keyFor(userId = USER_A, parts: Partial<typeof NOTE> & { organizationId?: string } = {}) {
  return draftStorageKey({
    organizationId: parts.organizationId ?? ORG,
    userId,
    recordType: parts.recordType ?? NOTE.recordType,
    recordId: parts.recordId ?? NOTE.recordId,
    field: parts.field ?? NOTE.field,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  localStorage.clear();
  signIn(USER_A);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the draft key', () => {
  it('is made of organisation, user, record type, record id and field', () => {
    const key = keyFor();
    for (const part of [ORG, USER_A, 'JOB', 'job-1', 'note']) expect(key).toContain(part);
  });

  it('differs when any one part differs', () => {
    const base = keyFor();
    expect(keyFor(USER_B)).not.toBe(base);
    expect(keyFor(USER_A, { organizationId: 'org-other' })).not.toBe(base);
    expect(keyFor(USER_A, { recordType: 'LEAD' })).not.toBe(base);
    expect(keyFor(USER_A, { recordId: 'job-2' })).not.toBe(base);
    expect(keyFor(USER_A, { field: 'reason' })).not.toBe(base);
  });

  it('cannot be forged by a separator inside a part', () => {
    const a = draftStorageKey({ organizationId: 'o', userId: 'u:x', recordType: 'T', recordId: 'r', field: 'f' });
    const b = draftStorageKey({ organizationId: 'o', userId: 'u', recordType: 'x:T', recordId: 'r', field: 'f' });
    expect(a).not.toBe(b);
  });
});

describe('useFieldDraft: saving', () => {
  it('writes to device storage after the debounce, not on every keystroke', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('Replaced the strike plate'));
    expect(result.current.value).toBe('Replaced the strike plate');
    expect(localStorage.getItem(keyFor())).toBeNull();

    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1); });
    expect(localStorage.getItem(keyFor())).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(readDraft(keyFor())).toBe('Replaced the strike plate');
  });

  it('restarts the debounce on each keystroke and saves only the latest text', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('Rep'));
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 50); });
    act(() => result.current.setValue('Replaced'));
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 50); });
    expect(readDraft(keyFor())).toBeNull();
    act(() => { vi.advanceTimersByTime(50); });
    expect(readDraft(keyFor())).toBe('Replaced');
  });

  it('flushes at once when the page is hidden (backgrounded, the camera, a locked screen)', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('typed, then the camera opened'));
    expect(readDraft(keyFor())).toBeNull();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(readDraft(keyFor())).toBe('typed, then the camera opened');
  });

  it('does not flush on a visibilitychange to visible', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('still typing'));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(readDraft(keyFor())).toBeNull();
  });

  it('flushes at once on pagehide (window)', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('page left mid-sentence'));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(readDraft(keyFor())).toBe('page left mid-sentence');
  });

  it('flushes at once on freeze (document)', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('frozen mid-sentence'));
    act(() => { document.dispatchEvent(new Event('freeze')); });
    expect(readDraft(keyFor())).toBe('frozen mid-sentence');
  });

  it('flushes when the field unmounts (a tab switch), and the late timer writes nothing more', () => {
    const { result, unmount } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('tab switched away'));
    unmount();
    expect(readDraft(keyFor())).toBe('tab switched away');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2); });
    expect(setItem).not.toHaveBeenCalled();
  });

  it('removes the draft when the text is emptied (nothing to restore)', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('something'));
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS); });
    expect(readDraft(keyFor())).toBe('something');
    act(() => result.current.setValue(''));
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS); });
    expect(localStorage.getItem(keyFor())).toBeNull();
  });
});

describe('useFieldDraft: restoring', () => {
  it('starts empty and not restored when there is no draft', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    expect(result.current.value).toBe('');
    expect(result.current.restored).toBe(false);
  });

  it('restores on mount, on the first render, with the restored flag', () => {
    writeDraft(keyFor(), 'left on the lock screen');
    const seen: Array<{ value: string; restored: boolean }> = [];
    renderHook(() => {
      const draft = useFieldDraft(NOTE);
      seen.push({ value: draft.value, restored: draft.restored });
      return draft;
    });
    expect(seen[0]).toEqual({ value: 'left on the lock screen', restored: true });
  });

  it('text typed in this mount is not "restored"', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('fresh'));
    expect(result.current.restored).toBe(false);
  });

  it('survives a full remount (the page was killed and relaunched)', () => {
    const first = renderHook(() => useFieldDraft(NOTE));
    act(() => first.result.current.setValue('typed before the kill'));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    first.unmount();

    const second = renderHook(() => useFieldDraft(NOTE));
    expect(second.result.current.value).toBe('typed before the kill');
    expect(second.result.current.restored).toBe(true);
  });

  it("switches to another record's draft when the record id changes", () => {
    writeDraft(keyFor(USER_A, { recordId: 'job-2' }), 'job two draft');
    const { result, rerender } = renderHook(
      (props: { recordId: string }) => useFieldDraft({ ...NOTE, recordId: props.recordId }),
      { initialProps: { recordId: 'job-1' } },
    );
    expect(result.current.value).toBe('');
    rerender({ recordId: 'job-2' });
    expect(result.current.value).toBe('job two draft');
    expect(result.current.restored).toBe(true);
  });

  it("flushes the first record's pending text when the record id changes", () => {
    const { result, rerender } = renderHook(
      (props: { recordId: string }) => useFieldDraft({ ...NOTE, recordId: props.recordId }),
      { initialProps: { recordId: 'job-1' } },
    );
    act(() => result.current.setValue('for job one'));
    rerender({ recordId: 'job-2' });
    expect(readDraft(keyFor(USER_A, { recordId: 'job-1' }))).toBe('for job one');
    expect(readDraft(keyFor(USER_A, { recordId: 'job-2' }))).toBeNull();
  });
});

describe('useFieldDraft: clearing', () => {
  it('clear() empties the field, removes the draft and cancels a pending write (clear on save)', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('about to be saved'));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(readDraft(keyFor())).toBe('about to be saved');

    act(() => result.current.setValue('about to be saved!'));
    act(() => result.current.clear());
    expect(result.current.value).toBe('');
    expect(result.current.restored).toBe(false);
    expect(localStorage.getItem(keyFor())).toBeNull();

    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS * 2); });
    expect(localStorage.getItem(keyFor())).toBeNull();
  });

  it('clearing a restored draft drops the restored flag (Discard)', () => {
    writeDraft(keyFor(), 'old text');
    const { result } = renderHook(() => useFieldDraft(NOTE));
    expect(result.current.restored).toBe(true);
    act(() => result.current.clear());
    expect(result.current.restored).toBe(false);
    expect(result.current.value).toBe('');
    expect(localStorage.getItem(keyFor())).toBeNull();
  });

  it('a field that unmounts after a save does not write the old text back', () => {
    const { result, unmount } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('saved text'));
    act(() => result.current.clear());
    unmount();
    expect(localStorage.getItem(keyFor())).toBeNull();
  });
});

describe('expiry', () => {
  it('a draft older than 7 days is not restored, and is deleted', () => {
    expect(DRAFT_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    writeDraft(keyFor(), 'stale', Date.now() - DRAFT_TTL_MS - 1);
    const { result } = renderHook(() => useFieldDraft(NOTE));
    expect(result.current.value).toBe('');
    expect(result.current.restored).toBe(false);
    expect(localStorage.getItem(keyFor())).toBeNull();
  });

  it('a draft just inside 7 days is restored', () => {
    writeDraft(keyFor(), 'recent', Date.now() - DRAFT_TTL_MS + 60_000);
    const { result } = renderHook(() => useFieldDraft(NOTE));
    expect(result.current.value).toBe('recent');
  });

  it('every save restarts the clock', () => {
    writeDraft(keyFor(), 'old', Date.now() - DRAFT_TTL_MS + 1000);
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('old plus more'));
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS); });
    vi.setSystemTime(Date.now() + DRAFT_TTL_MS - 60_000);
    expect(readDraft(keyFor())).toBe('old plus more');
  });

  it('stale drafts of other fields are swept when a draft field first mounts', () => {
    const other = keyFor(USER_A, { recordId: 'job-99' });
    writeDraft(other, 'ancient', Date.now() - DRAFT_TTL_MS - 1000);
    renderHook(() => useFieldDraft(NOTE));
    // Raw storage, not readDraft: readDraft deletes an expired draft itself and would hide a missing sweep.
    expect(localStorage.getItem(other)).toBeNull();
  });
});

describe('keying by organisation and user', () => {
  it("a second user on the same device never sees the first user's draft", () => {
    const first = renderHook(() => useFieldDraft(NOTE));
    act(() => first.result.current.setValue('private customer details'));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    first.unmount();

    signIn(USER_B);
    const second = renderHook(() => useFieldDraft(NOTE));
    expect(second.result.current.value).toBe('');
    expect(second.result.current.restored).toBe(false);
  });

  it('the same user in another organisation does not see it either', () => {
    writeDraft(keyFor(), 'org one draft');
    signIn(USER_A, 'org-other');
    const { result } = renderHook(() => useFieldDraft(NOTE));
    expect(result.current.value).toBe('');
  });

  it('the first user finds their draft again after the second has come and gone', () => {
    writeDraft(keyFor(USER_A), 'still mine');
    signIn(USER_B);
    renderHook(() => useFieldDraft(NOTE)).unmount();
    signIn(USER_A);
    const { result } = renderHook(() => useFieldDraft(NOTE));
    expect(result.current.value).toBe('still mine');
  });

  it('with nobody signed in nothing is persisted', () => {
    setUser(null);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('anonymous'));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(result.current.value).toBe('anonymous');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('enabled: false is the same: the field works, nothing is stored', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useFieldDraft({ ...NOTE, enabled: false }));
    act(() => result.current.setValue('not persisted'));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(result.current.value).toBe('not persisted');
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('clearUserDrafts (a user-initiated sign-out)', () => {
  it("removes every draft of that user and organisation, and only theirs", () => {
    writeDraft(keyFor(USER_A), 'a1');
    writeDraft(keyFor(USER_A, { recordId: 'job-2' }), 'a2');
    writeDraft(keyFor(USER_B), 'b1');
    writeDraft(keyFor(USER_A, { organizationId: 'org-other' }), 'a-other-org');
    localStorage.setItem('servwave_user', '{"keep":"me"}');

    clearUserDrafts(ORG, USER_A);

    expect(localStorage.getItem(keyFor(USER_A))).toBeNull();
    expect(localStorage.getItem(keyFor(USER_A, { recordId: 'job-2' }))).toBeNull();
    expect(readDraft(keyFor(USER_B))).toBe('b1');
    expect(readDraft(keyFor(USER_A, { organizationId: 'org-other' }))).toBe('a-other-org');
    expect(localStorage.getItem('servwave_user')).toBe('{"keep":"me"}');
  });

  it('removeDraft removes one', () => {
    writeDraft(keyFor(), 'x');
    removeDraft(keyFor());
    expect(readDraft(keyFor())).toBeNull();
  });
});

describe('when storage throws (private mode, blocked site data)', () => {
  it('the field still works, keeps the text in memory, and never errors', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('SecurityError'); });

    const first = renderHook(() => useFieldDraft({ ...NOTE, recordId: 'job-mem' }));
    expect(() => {
      act(() => first.result.current.setValue('kept in memory'));
      act(() => { window.dispatchEvent(new Event('pagehide')); });
    }).not.toThrow();
    expect(first.result.current.value).toBe('kept in memory');
    first.unmount();

    // Same page session: the draft is still there on remount, from memory.
    const second = renderHook(() => useFieldDraft({ ...NOTE, recordId: 'job-mem' }));
    expect(second.result.current.value).toBe('kept in memory');
    expect(second.result.current.restored).toBe(true);
    expect(() => act(() => second.result.current.clear())).not.toThrow();
    expect(second.result.current.value).toBe('');

    const third = renderHook(() => useFieldDraft({ ...NOTE, recordId: 'job-mem' }));
    expect(third.result.current.value).toBe('');
  });

  it('a localStorage accessor that throws does not crash a mount', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new Error('SecurityError'); });
    const { result } = renderHook(() => useFieldDraft({ ...NOTE, recordId: 'job-blocked' }));
    expect(result.current.value).toBe('');
    expect(() => act(() => result.current.setValue('ok'))).not.toThrow();
    expect(result.current.value).toBe('ok');
  });
});

describe('the unsaved-work signal', () => {
  it('is raised while the field holds text, and released on clear', () => {
    expect(hasUnsavedWork()).toBe(false);
    const { result } = renderHook(() => useFieldDraft(NOTE));
    expect(hasUnsavedWork()).toBe(false);
    act(() => result.current.setValue('half a note'));
    expect(hasUnsavedWork()).toBe(true);
    act(() => result.current.clear());
    expect(hasUnsavedWork()).toBe(false);
  });

  it('a restored draft raises it from the first render', () => {
    writeDraft(keyFor(), 'restored text');
    renderHook(() => useFieldDraft(NOTE));
    expect(hasUnsavedWork()).toBe(true);
  });

  it('is released when the field unmounts (the draft itself stays on the device)', () => {
    const { result, unmount } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('text'));
    unmount();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('whitespace alone is not unsaved work', () => {
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('   \n'));
    expect(hasUnsavedWork()).toBe(false);
  });
});

describe('drafts never leave the device', () => {
  it('the hook and store make no network request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const beacon = vi.fn();
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    const { result } = renderHook(() => useFieldDraft(NOTE));
    act(() => result.current.setValue('customer: 12 Elm St, gate code 4411'));
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });
});
