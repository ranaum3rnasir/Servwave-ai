/**
 * Stale-chunk recovery: what the app does when a lazily loaded chunk fails to load.
 *
 * Every page is a lazy route chunk with a content-hashed name. A deploy replaces those files,
 * so a tab that was open across the deploy asks for a chunk the server no longer has, and
 * the dynamic import rejects. Before this module the rejection reached the top-level error
 * boundary and the user was stranded on "Something went wrong".
 *
 * The fix is to reload ONCE: the reloaded page fetches the new index and the new chunk names.
 * If that does not help (the network is down, or a deploy is still rolling out), the
 * boundary shows a Reload prompt rather than reloading again. The guard is a timestamp in
 * this tab's sessionStorage, so it survives the reload it protects against, and a chunk
 * that keeps failing gets exactly one automatic reload per window, never a loop.
 *
 * `shouldReloadNow` is the one decision, kept pure so it can be tested in isolation. It
 * takes an unsaved-work flag so a later caller (the update prompt) can feed it the shared
 * unsaved-work signal. The error boundary passes nothing: by the time it catches, the tree
 * that held any work has already unmounted.
 */

import { reloadPage } from './reloadPage';

/** sessionStorage key holding the time of this tab's last automatic reload. */
export const CHUNK_RELOAD_GUARD_KEY = 'servwave:chunk-reload-at';

/**
 * No second automatic reload within this window. Long enough that a slow phone reloading
 * a large bundle cannot fail again outside it, short enough that a separate deploy later in
 * the day still recovers by itself.
 */
export const CHUNK_RELOAD_GUARD_MS = 5 * 60_000;

/**
 * The messages browsers and the bundler use for a lazy chunk that could not be loaded.
 * Matched on the message because the error types are plain TypeErrors.
 */
const CHUNK_ERROR_PATTERNS: readonly RegExp[] = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // WebKit (Safari and every iPhone browser)
  // WebKit again, when the host answers the missing chunk with the app's HTML (the SPA
  // rewrite does exactly that for a file a deploy removed). Measured in WebKit 2026-10-02.
  /is not a valid JavaScript MIME type for module script/i,
  /Unable to preload CSS for/i, // the bundler's CSS preload for a lazy chunk
  /Loading (CSS )?chunk [\w-]+ failed/i, // older bundler wording
];

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(error.message));
}

export interface ReloadDecisionInput {
  /** Current time, in ms since the epoch. */
  now: number;
  /** When this tab last reloaded automatically, or null if it never has. */
  lastAutoReloadAt: number | null;
  /** True while a form or draft holds work a reload would discard. */
  hasUnsavedWork?: boolean;
}

/** The "should reload now" decision. Pure. */
export function shouldReloadNow({ now, lastAutoReloadAt, hasUnsavedWork = false }: ReloadDecisionInput): boolean {
  if (hasUnsavedWork) return false;
  if (lastAutoReloadAt === null) return true;
  const elapsed = now - lastAutoReloadAt;
  // A negative gap means the clock moved back; treat it as "just reloaded" and hold off.
  return elapsed >= CHUNK_RELOAD_GUARD_MS;
}

export type ChunkRecoveryOutcome = 'reloading' | 'show-reload-prompt';

type GuardStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ChunkRecoveryDeps {
  /** Returns the tab's storage; may throw or return null where storage is blocked. */
  storage?: () => GuardStorage | null;
  now?: () => number;
  reload?: () => void;
  hasUnsavedWork?: boolean;
}

function defaultStorage(): GuardStorage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage;
}

function readGuard(storage: GuardStorage): number | null {
  const raw = storage.getItem(CHUNK_RELOAD_GUARD_KEY);
  if (raw === null) return null;
  const at = Number(raw);
  return Number.isFinite(at) ? at : null;
}

/**
 * Called once a chunk failure has been caught. Reloads the page when the decision allows it
 * and the guard could be written first; otherwise the caller shows the Reload prompt.
 *
 * If the guard cannot be stored, it does NOT reload: without a guard the reloaded page could
 * not tell it had already tried, and that is exactly the loop this module exists to prevent.
 */
export function recoverFromChunkLoadError(deps: ChunkRecoveryDeps = {}): ChunkRecoveryOutcome {
  const { storage = defaultStorage, now = Date.now, reload = reloadPage, hasUnsavedWork = false } = deps;
  const at = now();
  try {
    const store = storage();
    if (!store) return 'show-reload-prompt';
    if (!shouldReloadNow({ now: at, lastAutoReloadAt: readGuard(store), hasUnsavedWork })) {
      return 'show-reload-prompt';
    }
    store.setItem(CHUNK_RELOAD_GUARD_KEY, String(at));
  } catch {
    return 'show-reload-prompt';
  }
  reload();
  return 'reloading';
}
