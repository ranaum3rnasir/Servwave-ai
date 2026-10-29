import { describe, it, expect, vi } from 'vitest';
import {
  CHUNK_RELOAD_GUARD_KEY,
  CHUNK_RELOAD_GUARD_MS,
  isChunkLoadError,
  recoverFromChunkLoadError,
  shouldReloadNow,
} from './chunkRecovery';

/** A Storage stand-in that survives "reloads", the way one tab's sessionStorage does. */
function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    data,
  };
}

describe('isChunkLoadError', () => {
  it.each([
    // Chromium: the dynamic import() of a chunk the deploy removed.
    ['chromium', new TypeError('Failed to fetch dynamically imported module: https://app.example/assets/JobsPage-abc123.js')],
    // Firefox.
    ['firefox', new TypeError('error loading dynamically imported module: https://app.example/assets/JobsPage-abc123.js')],
    // WebKit (Safari, every iPhone browser).
    ['webkit', new TypeError('Importing a module script failed.')],
    // WebKit when the host answers the missing chunk with the app's HTML (the SPA rewrite),
    // which is what a deployed host does for a file that no longer exists.
    [
      'webkit html-for-missing-chunk',
      new TypeError(
        "'text/html' is not a valid JavaScript MIME type for module script 'https://app.example/assets/JobsPage-abc123.js'.",
      ),
    ],
    // The bundler's CSS preload for a lazy chunk.
    ['css preload', new Error('Unable to preload CSS for /assets/JobsPage-abc123.css')],
  ])('recognises the %s message', (_label, error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it('recognises an error named ChunkLoadError', () => {
    const error = new Error('Loading chunk 12 failed.');
    error.name = 'ChunkLoadError';
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    ['a render bug', new Error("Cannot read properties of undefined (reading 'name')")],
    ['an API failure', new Error('Request failed with status code 500')],
    ['a plain fetch failure', new TypeError('Failed to fetch')],
    ['a string', 'Failed to fetch dynamically imported module'],
    ['null', null],
    ['undefined', undefined],
  ])('does not treat %s as a chunk failure', (_label, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

describe('shouldReloadNow', () => {
  const now = 1_000_000_000_000;

  it('reloads when this tab has never auto-reloaded', () => {
    expect(shouldReloadNow({ now, lastAutoReloadAt: null })).toBe(true);
  });

  it('does not reload again inside the guard window', () => {
    expect(shouldReloadNow({ now, lastAutoReloadAt: now - 1 })).toBe(false);
    expect(shouldReloadNow({ now, lastAutoReloadAt: now - CHUNK_RELOAD_GUARD_MS + 1 })).toBe(false);
  });

  it('allows one more reload once the window has passed (a later, separate deploy)', () => {
    expect(shouldReloadNow({ now, lastAutoReloadAt: now - CHUNK_RELOAD_GUARD_MS })).toBe(true);
  });

  it('does not reload when a recorded attempt is in the future (clock moved back)', () => {
    expect(shouldReloadNow({ now, lastAutoReloadAt: now + 60_000 })).toBe(false);
  });

  it('never reloads while there is unsaved work', () => {
    expect(shouldReloadNow({ now, lastAutoReloadAt: null, hasUnsavedWork: true })).toBe(false);
  });
});

describe('recoverFromChunkLoadError', () => {
  it('reloads once on the first failure and records the attempt', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const outcome = recoverFromChunkLoadError({ storage: () => storage, now: () => 5_000, reload });
    expect(outcome).toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.data.get(CHUNK_RELOAD_GUARD_KEY)).toBe('5000');
  });

  it('shows the Reload prompt when the reload did not help, without reloading again', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    // First failure: auto-reload.
    recoverFromChunkLoadError({ storage: () => storage, now: () => 5_000, reload });
    // The reloaded page fails again a few seconds later.
    const outcome = recoverFromChunkLoadError({ storage: () => storage, now: () => 9_000, reload });
    expect(outcome).toBe('show-reload-prompt');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never loops: a chunk that keeps failing gets exactly one reload', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    let t = 10_000;
    const outcomes = Array.from({ length: 25 }, () => {
      t += 2_000; // each "reload" fails two seconds later
      return recoverFromChunkLoadError({ storage: () => storage, now: () => t, reload });
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(outcomes[0]).toBe('reloading');
    expect(outcomes.slice(1).every((o) => o === 'show-reload-prompt')).toBe(true);
  });

  it('does not reload when the guard cannot be stored (no guard means no reload)', () => {
    const reload = vi.fn();
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(recoverFromChunkLoadError({ storage: () => throwing, now: () => 1, reload })).toBe(
      'show-reload-prompt',
    );
    expect(recoverFromChunkLoadError({ storage: () => null, now: () => 1, reload })).toBe(
      'show-reload-prompt',
    );
    expect(
      recoverFromChunkLoadError({
        storage: () => {
          throw new Error('SecurityError');
        },
        now: () => 1,
        reload,
      }),
    ).toBe('show-reload-prompt');
    expect(reload).not.toHaveBeenCalled();
  });

  it('treats an unreadable guard value as "never reloaded"', () => {
    const storage = memoryStorage({ [CHUNK_RELOAD_GUARD_KEY]: 'not-a-number' });
    const reload = vi.fn();
    expect(recoverFromChunkLoadError({ storage: () => storage, now: () => 1, reload })).toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload while there is unsaved work', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(
      recoverFromChunkLoadError({ storage: () => storage, now: () => 1, reload, hasUnsavedWork: true }),
    ).toBe('show-reload-prompt');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.data.has(CHUNK_RELOAD_GUARD_KEY)).toBe(false);
  });
});
