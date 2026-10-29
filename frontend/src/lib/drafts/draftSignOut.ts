/**
 * Field drafts, the sign-out half (mobile slice 66 staging fix).
 *
 * The auth store is in the staff app's initial JavaScript, which has a gzipped ceiling the build
 * enforces, and a user-initiated sign-out has to purge that user's drafts. So the little a purge
 * needs (the key prefix, the storage handle, the in-memory fallback, and `clearUserDrafts`) lives
 * here, and `fieldDraftStore` (read, write, expiry, key builder: only the field-draft hook in a
 * lazy chunk uses them) builds on it. Keep this module small: whatever is added here is paid for
 * by every first paint.
 *
 * Never throws: `localStorage` can throw on being touched at all (private mode, blocked site
 * data), and each of those falls back to the page-session map.
 */

export const PREFIX = 'servwave:draft:v1:';

/** Each part is percent-encoded, so a ":" inside a part can never read as a separator. */
export const enc = (part: string) => encodeURIComponent(part);

export function userPrefix(organizationId: string, userId: string): string {
  return `${enc(organizationId)}:${enc(userId)}:`;
}

/** This page session's fallback, used whenever storage throws. Keys are the storage keys. */
export const memory = new Map<string, string>();

export function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function rawRemove(key: string): void {
  memory.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {
    // nothing more to do: the memory copy is already gone
  }
}

export function rawKeys(): string[] {
  const keys = new Set(memory.keys());
  try {
    const store = storage();
    if (store) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key) keys.add(key);
      }
    }
  } catch {
    // memory keys only
  }
  return [...keys].filter((key) => key.startsWith(PREFIX));
}

/** Every draft of one user in one organisation. A user-initiated sign-out calls this. */
export function clearUserDrafts(organizationId: string, userId: string): void {
  const prefix = `${PREFIX}${userPrefix(organizationId, userId)}`;
  for (const key of rawKeys()) {
    if (key.startsWith(prefix)) rawRemove(key);
  }
}
