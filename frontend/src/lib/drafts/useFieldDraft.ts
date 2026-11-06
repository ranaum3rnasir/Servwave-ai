import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useAuthStore } from '@/stores/auth.store';
import { registerUnsavedWork } from '@/ui-kit/lib/unsavedWork';
import {
  draftStorageKey,
  purgeExpiredDrafts,
  readDraft,
  removeDraft,
  writeDraft,
} from './fieldDraftStore';

/**
 * The one hook that keeps a text field's work until it is saved (mobile slice 57, PRD module 11).
 *
 *   const note = useFieldDraft({ recordType: 'JOB', recordId: jobId, field: 'note' });
 *   <Textarea value={note.value} onChange={(e) => note.setValue(e.target.value)} />
 *   <DraftRestoredNote restored={note.restored} onDiscard={note.clear} />
 *   ... onSuccess: note.clear()
 *
 * It owns the keying (organisation and user come from the signed-in account; the surface passes
 * the record type, record id and field), the debounced save to device storage, the immediate
 * flush when the page is hidden or frozen (backgrounding, the camera, a locked screen) or the
 * field unmounts (a tab switch), the restore on mount, the 7-day expiry, and the unsaved-work
 * signal while the field holds text. Storage failing never breaks the field (see the store).
 *
 * `clear` is for the surface to call: after a successful save, on an explicit Cancel, and from the
 * Discard control on the "Draft restored" note. Nothing else removes a draft except expiry and a
 * user-initiated sign-out.
 *
 * With nobody signed in, or `enabled: false` (the user cannot save to this record anyway), the
 * field works in component state only and nothing is stored.
 */

/** Quiet time after the last keystroke before the text is written to storage. */
export const DRAFT_DEBOUNCE_MS = 400;

export interface UseFieldDraftOptions {
  recordType: string;
  recordId: string;
  field: string;
  /** False: keep the text in component state only. Default true. */
  enabled?: boolean;
  /**
   * The SAVED text of a field that already holds some (a walkthrough note, a logged entry's
   * notes). The field opens on it, a draft is only text that differs from it, and the unsaved-work
   * signal is on only while the text differs. Read when the field mounts (or moves to another
   * record), not on every render: the surface re-mounts the field when the saved text changes.
   * Default '' (a new note: any text is unsaved work).
   */
  baseline?: string;
}

export interface FieldDraft {
  value: string;
  setValue: (next: string) => void;
  /** Put the field back to its baseline ('' without one) and delete its draft. */
  clear: () => void;
  /**
   * The text on screen has just been saved: delete the draft and make that text the new baseline,
   * leaving it in the field. For a field that stays on screen after saving (clear would blank it).
   * Pass `sent` (the text the save request carried) when the field stays editable while saving:
   * if the person typed on after sending, `sent` becomes the baseline and the longer text stays
   * as an unsent draft, in the field and in storage.
   */
  markSaved: (sent?: string) => void;
  /** True when the text on screen came back from storage on mount. */
  restored: boolean;
}

interface Slot {
  key: string | null;
  value: string;
  restored: boolean;
  /** The saved text this field is measured against. */
  baseline: string;
}

function load(key: string | null, baseline: string): Slot {
  if (!key) return { key, value: baseline, restored: false, baseline };
  purgeExpiredDrafts();
  const saved = readDraft(key);
  return { key, value: saved ?? baseline, restored: saved !== null, baseline };
}

export function useFieldDraft({
  recordType, recordId, field, enabled = true, baseline = '',
}: UseFieldDraftOptions): FieldDraft {
  const organizationId = useAuthStore((s) => s.user?.organization_id ?? null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const key =
    enabled && organizationId && userId
      ? draftStorageKey({ organizationId, userId, recordType, recordId, field })
      : null;

  const id = useId();
  const [slot, setSlot] = useState<Slot>(() => load(key, baseline));

  // A different record (or account) is a different draft: re-read during render, so the first
  // paint of the new key already shows its text. The old key's pending write is flushed by the
  // effect cleanup below.
  let current = slot;
  if (slot.key !== key) {
    current = load(key, baseline);
    setSlot(current);
  }

  const valueRef = useRef(current.value);
  const baselineRef = useRef(current.baseline);
  const keyRef = useRef(key);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);

  // The save the debounce, the hide events and the unmount cleanup all share. Idempotent: a
  // second call with nothing pending does nothing.
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!pendingRef.current) return;
    pendingRef.current = false;
    if (!keyRef.current) return;
    // Text that is back to the saved text is no draft at all.
    if (valueRef.current === baselineRef.current) removeDraft(keyRef.current);
    else writeDraft(keyRef.current, valueRef.current);
  }, []);

  const setValue = useCallback(
    (next: string) => {
      valueRef.current = next;
      setSlot((prev) => ({ ...prev, value: next }));
      if (!keyRef.current) return;
      pendingRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, DRAFT_DEBOUNCE_MS);
    },
    [flush],
  );

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = false;
    valueRef.current = baselineRef.current;
    if (keyRef.current) removeDraft(keyRef.current);
    setSlot((prev) => ({ ...prev, value: prev.baseline, restored: false }));
  }, []);

  const markSaved = useCallback((sent?: string) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = false;
    // Typed on after the text was sent: what was sent is saved, the rest is still an unsent draft.
    if (sent !== undefined && sent !== valueRef.current) {
      baselineRef.current = sent;
      if (keyRef.current) writeDraft(keyRef.current, valueRef.current);
      setSlot((prev) => ({ ...prev, baseline: sent, restored: false }));
      return;
    }
    baselineRef.current = valueRef.current;
    if (keyRef.current) removeDraft(keyRef.current);
    setSlot((prev) => ({ ...prev, baseline: prev.value, restored: false }));
  }, []);

  // Keep the refs on the committed key's value. Cleanups of the effect below run BEFORE this
  // one on a key change, so they still see the old key and the old text.
  useEffect(() => {
    keyRef.current = key;
    valueRef.current = current.value;
    baselineRef.current = current.baseline;
  });

  // The page being hidden or frozen: save NOW, because the browser may never run another timer.
  // The cleanup flushes too: a field unmounting (a tab switch) or moving to another record keeps
  // what was typed.
  useEffect(() => {
    if (!key) return undefined;
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onHide);
    document.addEventListener('freeze', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      document.removeEventListener('freeze', flush);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [key, flush]);

  // The shared unsaved-work signal, for as long as the field holds text that is not the saved text.
  const hasText = current.value.trim() !== current.baseline.trim();
  useEffect(() => {
    if (!hasText) return undefined;
    return registerUnsavedWork(id);
  }, [hasText, id]);

  return { value: current.value, setValue, clear, markSaved, restored: current.restored };
}
