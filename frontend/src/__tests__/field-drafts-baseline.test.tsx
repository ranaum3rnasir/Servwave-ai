/**
 * Mobile slice 66: a draft of a field that ALREADY holds saved text (a walkthrough note, a logged
 * entry's notes) needs a baseline. The field opens on the saved text, a draft is only the part
 * that differs from it, and the unsaved-work signal is on only while the text differs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useAuthStore, type User } from '@/stores/auth.store';
import { hasUnsavedWork } from '@/ui-kit/lib/unsavedWork';
import { draftStorageKey, readDraft, writeDraft } from '@/lib/drafts/fieldDraftStore';
import { DRAFT_DEBOUNCE_MS, useFieldDraft } from '@/lib/drafts/useFieldDraft';

const ORG = 'org-aaaa';
const USER = 'user-aaaa';
const FIELD = { recordType: 'LEAD', recordId: 'lead-1', field: 'walkthrough_notes' } as const;
const key = () => draftStorageKey({ organizationId: ORG, userId: USER, ...FIELD });

function signIn() {
  const user = { id: USER, organization_id: ORG } as User;
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: unknown) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  localStorage.clear();
  signIn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useFieldDraft with a baseline', () => {
  it('opens on the saved text, not restored, and not unsaved work', () => {
    const { result } = renderHook(() => useFieldDraft({ ...FIELD, baseline: 'Measured the frame' }));
    expect(result.current.value).toBe('Measured the frame');
    expect(result.current.restored).toBe(false);
    expect(hasUnsavedWork()).toBe(false);
  });

  it('a stored draft wins over the saved text and is flagged restored', () => {
    writeDraft(key(), 'Measured the frame, and the closer');
    const { result } = renderHook(() => useFieldDraft({ ...FIELD, baseline: 'Measured the frame' }));
    expect(result.current.value).toBe('Measured the frame, and the closer');
    expect(result.current.restored).toBe(true);
    expect(hasUnsavedWork()).toBe(true);
  });

  it('typing something different saves a draft and raises the signal; typing it back removes both', () => {
    const { result } = renderHook(() => useFieldDraft({ ...FIELD, baseline: 'Measured the frame' }));
    act(() => result.current.setValue('Measured the frame, closer too'));
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS); });
    expect(readDraft(key())).toBe('Measured the frame, closer too');
    expect(hasUnsavedWork()).toBe(true);

    act(() => result.current.setValue('Measured the frame'));
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS); });
    expect(readDraft(key())).toBeNull();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('clear puts the saved text back and deletes the draft', () => {
    const { result } = renderHook(() => useFieldDraft({ ...FIELD, baseline: 'Measured the frame' }));
    act(() => result.current.setValue('something else'));
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS); });
    act(() => result.current.clear());
    expect(result.current.value).toBe('Measured the frame');
    expect(readDraft(key())).toBeNull();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('markSaved deletes the draft but keeps the text on screen, which is now the saved text', () => {
    const { result } = renderHook(() => useFieldDraft({ ...FIELD, baseline: 'Measured the frame' }));
    act(() => result.current.setValue('Measured the frame, closer too'));
    act(() => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS); });
    act(() => result.current.markSaved());
    expect(readDraft(key())).toBeNull();
    expect(result.current.value).toBe('Measured the frame, closer too');
    expect(result.current.restored).toBe(false);
    expect(hasUnsavedWork()).toBe(false);
  });

  it('a draft typed but not yet flushed survives an unmount', () => {
    const { result, unmount } = renderHook(() => useFieldDraft({ ...FIELD, baseline: 'Measured the frame' }));
    act(() => result.current.setValue('Measured the frame, closer too'));
    unmount();
    expect(readDraft(key())).toBe('Measured the frame, closer too');
  });
});
