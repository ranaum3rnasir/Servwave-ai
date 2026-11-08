import type SharpConstructor from 'sharp';

/**
 * The image library, loaded on first use rather than at boot.
 *
 * `sharp` binds a large native library (libvips). A top-level import made
 * every server boot map it, and on the self-hosted macOS CI runner that load
 * intermittently stalled in the kernel's code-signature check - the server
 * never answered /health and the Database job timed out before any database
 * or app code ran. Only the logo and avatar upload handlers need it, so they
 * ask for it here. Guarded by __tests__/sharp-lazy-load.test.ts.
 *
 * Memoized on the promise, so concurrent first uploads share one load. A
 * failed load is not cached: the next upload retries instead of every later
 * upload failing on a rejection from the first.
 */
let loading: Promise<typeof SharpConstructor> | null = null;

export function loadSharp(): Promise<typeof SharpConstructor> {
  if (!loading) {
    loading = import('sharp').then(
      (m) => m.default,
      (err) => {
        loading = null;
        throw err;
      },
    );
  }
  return loading;
}
