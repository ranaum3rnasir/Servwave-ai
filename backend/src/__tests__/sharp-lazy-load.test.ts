import { describe, it, expect, vi } from 'vitest';

/*
 * The image library must not load at server boot.
 *
 * `sharp` binds a large native library (libvips). Loading it at module top
 * level made every boot map that library, and on the self-hosted macOS CI
 * runner that load intermittently stalled inside the kernel's code-signature
 * check: the server never answered /health and the Database job timed out
 * (runs 35718534288 and 36097519322) before any database or app code ran.
 * Only the logo and avatar upload handlers need it, so it is loaded there,
 * on first use.
 *
 * vi.mock factories run lazily - on the first import of the mocked module -
 * so the factory flipping `evaluated` is a direct record of whether anything
 * imported 'sharp'.
 */

const state = vi.hoisted(() => ({ evaluated: 0 }));

vi.mock('sharp', () => {
  state.evaluated += 1;
  return { default: vi.fn() };
});

describe('sharp is loaded on demand, never at boot', () => {
  it('importing the whole app (every controller and route) does not load sharp', async () => {
    await import('../app.js');
    await import('../controllers/organization.controller.js');
    await import('../controllers/user-avatar.controller.js');
    expect(state.evaluated).toBe(0);
  }, 60_000); // importing the whole app is slow; the default timeout is too tight

  it('loadSharp() is what loads it, memoizes the load, and hands back the constructor', async () => {
    const { loadSharp } = await import('../lib/load-sharp.js');
    expect(state.evaluated).toBe(0);

    const pending = loadSharp();
    // Concurrent first callers share one in-flight load.
    expect(loadSharp()).toBe(pending);
    const loaded = await pending;
    expect(state.evaluated).toBe(1);

    expect(loaded).toBe((await import('sharp')).default);
    expect(await loadSharp()).toBe(loaded);
  });
});
