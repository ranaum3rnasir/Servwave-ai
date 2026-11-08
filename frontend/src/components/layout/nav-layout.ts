import {
  DEFAULT_LAYOUT_KEYS, getDestination, CURRENT_LAYOUT_VERSION, LAYOUT_ADDITIONS,
} from './nav-registry';

const STORAGE_PREFIX = 'servwave:nav-layout:';
const VERSION_PREFIX = 'servwave:nav-layout-version:';
const storageKey = (userId: string) => `${STORAGE_PREFIX}${userId}`;
const versionKey = (userId: string) => `${VERSION_PREFIX}${userId}`;

// Legacy layouts (saved before the version system) have no version key → treated as v1.
function readVersion(userId: string): number {
  try {
    const v = Number(localStorage.getItem(versionKey(userId)));
    return Number.isFinite(v) && v > 0 ? v : 1;
  } catch {
    return 1;
  }
}

export function loadLayout(userId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return DEFAULT_LAYOUT_KEYS.slice();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_LAYOUT_KEYS.slice();
    let valid = parsed.filter(
      (k): k is string => typeof k === 'string' && !!getDestination(k)
    );
    if (valid.length === 0) return DEFAULT_LAYOUT_KEYS.slice();

    // One-time, version-gated migration: append nav items shipped after the user's stored layout
    // version (e.g. Service Plans), so a newly-released default reaches existing users WITHOUT
    // re-adding items they deliberately removed (those stay at the current version, so are skipped).
    const storedVersion = readVersion(userId);
    if (storedVersion < CURRENT_LAYOUT_VERSION) {
      const additions = LAYOUT_ADDITIONS
        .filter((a) => a.version > storedVersion && !!getDestination(a.key) && !valid.includes(a.key))
        .map((a) => a.key);
      valid = [...valid, ...additions];
      saveLayout(userId, valid); // stamps CURRENT_LAYOUT_VERSION so the migration runs once
    }
    return valid;
  } catch {
    return DEFAULT_LAYOUT_KEYS.slice();
  }
}

export function saveLayout(userId: string, keys: string[]): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(keys));
    localStorage.setItem(versionKey(userId), String(CURRENT_LAYOUT_VERSION));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

export function reorder(keys: string[], from: number, to: number): string[] {
  if (from === to) return keys;
  const next = keys.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return keys;
  next.splice(to, 0, moved);
  return next;
}

export function addKey(keys: string[], key: string): string[] {
  return keys.includes(key) ? keys : [...keys, key];
}

export function removeKey(keys: string[], key: string): string[] {
  return keys.filter((k) => k !== key);
}

export function resetLayout(userId: string): string[] {
  const next = DEFAULT_LAYOUT_KEYS.slice();
  saveLayout(userId, next);
  return next;
}
