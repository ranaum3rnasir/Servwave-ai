/**
 * Field drafts, the storage half (mobile slice 57, PRD module 11).
 *
 * Free text a technician types in the field (a job note, a cancel reason) is kept on the device
 * until it is saved, so the camera, a rotation, a locked screen or a killed tab does not eat it.
 * `useFieldDraft` is the one consumer; this module owns where and how a draft is stored.
 *
 * What it guarantees:
 *   - Scope. The key is organisation + user + record type + record id + field, so a second user
 *     on the same device (or the same user in another organisation) never meets the first one's
 *     draft. Drafts hold customer details, so they are device-only: nothing here, or in the hook,
 *     makes a request, and nothing is read for analytics.
 *   - Expiry. A draft last saved more than `DRAFT_TTL_MS` (7 days) ago is not restored and is
 *     deleted on sight; `purgeExpiredDrafts` sweeps the rest once per page load.
 *   - Never throws. `localStorage` can throw on read, on write, and even on being touched at all
 *     (private mode, blocked site data, a full quota). Each of those falls back to an in-memory
 *     map for this page session, so the field keeps working and a remount still restores.
 *
 * Clearing is the caller's: a successful save calls the hook's `clear`, and a USER-initiated
 * sign-out calls `clearUserDrafts` (auth store `logout`). A forced sign-out (a failed session
 * check, an expired token) must NOT purge: that is exactly when someone has just lost the
 * session under half a note.
 */

import {
  PREFIX,
  clearUserDrafts,
  enc,
  memory,
  rawKeys,
  rawRemove,
  storage,
  userPrefix,
} from './draftSignOut';

// The sign-out half (prefix, storage handle, memory fallback, `clearUserDrafts`) lives in
// `draftSignOut`, so the staff entry carries only that; see the note there.
export { clearUserDrafts };

export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DraftKeyParts {
  organizationId: string;
  userId: string;
  recordType: string;
  recordId: string;
  field: string;
}

interface StoredDraft {
  v: string;
  t: number;
}

export function draftStorageKey(parts: DraftKeyParts): string {
  return `${PREFIX}${userPrefix(parts.organizationId, parts.userId)}${enc(parts.recordType)}:${enc(parts.recordId)}:${enc(parts.field)}`;
}

// ─── Storage access, never throwing ──────────────────────────────────────────

function rawGet(key: string): string | null {
  try {
    const store = storage();
    if (store) return store.getItem(key);
  } catch {
    // fall through to memory
  }
  return memory.get(key) ?? null;
}

function rawSet(key: string, value: string): void {
  try {
    const store = storage();
    if (store) {
      store.setItem(key, value);
      memory.delete(key);
      return;
    }
  } catch {
    // fall through to memory
  }
  memory.set(key, value);
}

function parse(raw: string | null): StoredDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (parsed && typeof parsed.v === 'string' && typeof parsed.t === 'number') {
      return { v: parsed.v, t: parsed.t };
    }
  } catch {
    // a corrupt entry is treated as no draft
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** The saved text, or null when there is none, it is empty, or it has expired (and is deleted). */
export function readDraft(key: string, now: number = Date.now()): string | null {
  const stored = parse(rawGet(key));
  if (!stored) {
    return null;
  }
  if (now - stored.t > DRAFT_TTL_MS) {
    rawRemove(key);
    return null;
  }
  return stored.v.length > 0 ? stored.v : null;
}

/** Save `value` (restarting its 7 days). Text with nothing in it removes the draft instead. */
export function writeDraft(key: string, value: string, savedAt: number = Date.now()): void {
  if (value.trim().length === 0) {
    rawRemove(key);
    return;
  }
  rawSet(key, JSON.stringify({ v: value, t: savedAt } satisfies StoredDraft));
}

export function removeDraft(key: string): void {
  rawRemove(key);
}

/** Delete every draft older than 7 days, whoever's it is. Run once per page load. */
export function purgeExpiredDrafts(now: number = Date.now()): void {
  for (const key of rawKeys()) {
    const stored = parse(rawGet(key));
    if (!stored || now - stored.t > DRAFT_TTL_MS) rawRemove(key);
  }
}
