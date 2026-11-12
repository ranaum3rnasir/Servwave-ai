import '@testing-library/jest-dom';
import { afterAll, afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import * as webStreams from 'node:stream/web';

// The VM-based worker pool gives each file a context without Node's Web Streams globals; some
// test files and the e2e helpers they import need them. A no-op in the default pool, where they already exist.
for (const name of ['ReadableStream', 'WritableStream', 'TransformStream', 'TextEncoderStream', 'TextDecoderStream'] as const) {
  if (!(name in globalThis)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: webStreams[name] });
  }
}

// ─── Mock @/lib/axios ─────────────────────────────────────
vi.mock('@/lib/axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  },
}));

// ─── Mock @/lib/supabase ──────────────────────────────────
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      setSession: vi.fn(),
      signInWithOAuth: vi.fn().mockResolvedValue({ data: {}, error: null }),
      signOut: vi.fn(),
      refreshSession: vi.fn(),
    },
    // Realtime half of the client. The app opens no channel (the bell polls; the build swaps the
    // realtime client for an inert one), so nothing should call these: they stay as spies so a
    // test can assert that (NotificationBell.no-socket.test.tsx). `channel` is chainable because
    // the real API is (`.on(...).on(...).subscribe()`).
    realtime: { setAuth: vi.fn() },
    // Storage half. Direct-to-storage video uploads PUT the bytes straight at the bucket
    // with a short-lived URL the API mints, so the browser client's storage surface is now
    // on a real code path rather than only the auth one.
    storage: {
      from: vi.fn().mockReturnValue({
        uploadToSignedUrl: vi.fn().mockResolvedValue({ data: { path: 'uploaded/path' }, error: null }),
      }),
    },
    channel: vi.fn(() => {
      const chan: Record<string, unknown> = {};
      chan.on = vi.fn(() => chan);
      chan.subscribe = vi.fn(() => chan);
      return chan;
    }),
    removeChannel: vi.fn(),
  },
  getAccessToken: vi.fn(() => 'test-access-token'),
}));

// ─── Stub fetch + URL object-url (BrandingPage PDF preview) ────
if (!global.fetch) {
  global.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
}
// The test tool's fake-browser environment replaces URL.createObjectURL with a shim that copies a
// Blob's bytes out of a private field of the fake browser's Blob. From jsdom 30 that field is gone, so
// the shim throws for every Blob and File a test or the app makes. No test loads a blob: URL back (the
// fake browser cannot), so when the shim throws the caller gets a unique opaque blob: URL instead, which
// is all the app uses one for (an <img>/<iframe> src, a download link, a later revokeObjectURL).
const shimCreateObjectURL = global.URL.createObjectURL?.bind(global.URL);
global.URL.createObjectURL = (obj: Blob | MediaSource): string => {
  try {
    if (shimCreateObjectURL) return shimCreateObjectURL(obj);
  } catch {
    // fall through to the opaque URL
  }
  return `blob:nodedata:${crypto.randomUUID()}`;
};
if (!global.URL.revokeObjectURL) {
  global.URL.revokeObjectURL = () => {};
}

// ─── Mock @/stores/auth.store ─────────────────────────────
// Default: ADMIN user, override per test with vi.mocked(useAuthStore)
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        is_admin: true,
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })
  ),
  userDisplayName: (user: { first_name?: string; last_name?: string; email?: string } | null | undefined) =>
    user && (user.first_name || user.last_name)
      ? `${user.first_name} ${user.last_name}`.trim()
      : (user?.email ?? ''),
}));

// ─── Silence window.matchMedia ────────────────────────────
// configurable so a test can swap it with Object.defineProperty: in the VM-based worker pool the window
// is the jsdom one, where a property defined without flags is non-configurable and cannot be redefined
// (the default pool already makes these properties configurable).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ─── Radix Select jsdom polyfills ─────────────────────────
// jsdom doesn't implement these pointer/scroll APIs that Radix Select's
// open/close + scroll-into-view logic touches; without them the dropdown
// content never opens in tests (see #439's select-item-highlight spec).
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
// jsdom also lacks elementFromPoint, which react-big-calendar's Selection
// manager (a global mousedown/mousemove listener for click-drag event
// creation) calls on every pointer event anywhere in the document — this
// throws an uncaught exception whenever a test drives a real click (e.g.
// opening a Radix Select) while SchedulePage's calendar surface is mounted.
if (!document.elementFromPoint) {
  document.elementFromPoint = () => null;
}

// ─── Silence ResizeObserver ───────────────────────────────
// Must be a real, constructable class: components call `new ResizeObserver(...)`
// (DataTable's width measurement, Radix/floating-ui popovers). A vi.fn()-with-arrow
// stub is NOT a valid constructor ("... is not a constructor"), so several specs used
// to hand-roll their own class stub. This global class fixes it once, everywhere.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// ─── Polyfill Web Storage ─────────────────────────────────
// jsdom 28 no longer enables the Storage API by default, so `localStorage`
// is undefined in tests. Install a minimal in-memory shim only when absent
// (it backs the sidebar customization layout persistence — see useNavLayout).
class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}
if (typeof globalThis.localStorage === 'undefined') {
  const ls = new MemoryStorage() as unknown as Storage;
  Object.defineProperty(globalThis, 'localStorage', { value: ls, writable: true, configurable: true });
  Object.defineProperty(window, 'localStorage', { value: ls, writable: true, configurable: true });
}

// ─── RTL async timeout ────────────────────────────────────
// findBy*/waitFor default to 1s, which is a TRANSFORM budget here, not an app
// budget: a lazy() route (e.g. ReportRoute's report chunks) makes Vitest
// transform that whole module graph on first import, and DatePicker pulls
// react-day-picker into those chunks. The components are not slow; the
// bundler is cold, and it is worst under full-suite worker contention.
// 5 s (was 20 s): a wait that never succeeds now fails after 5 s, not 20 s. A test that really needs more
// passes its own `{ timeout }` and says why in a comment beside it (see docs/ci.md).
configure({ asyncUtilTimeout: 5_000 });

// ─── Let focus-scope unmount timers run while this file's window is alive ───
// @radix-ui/react-focus-scope (Dialog, Sheet, Popover, dropdown menus) schedules a
// setTimeout(0) when a scope unmounts; the timer builds a CustomEvent from the global scope and
// dispatches it on the unmounted container. React Testing Library unmounts everything in its own
// afterEach, so for the last test of a file that timer is created right as the file ends. If it
// fires after the file's jsdom window was torn down or swapped, the CustomEvent class no longer
// belongs to the container's realm and dispatchEvent throws "parameter 1 is not of type 'Event'"
// outside any test: vitest counts that as an unhandled error and fails the whole run, a rare race
// under CPU load. So: unmount everything ourselves, then wait one macrotask turn (a timer queued
// before ours with the same delay fires first) so no focus-scope timer survives the test or the
// file. Under fake timers the callback sits in the fake clock and never fires on its own, so
// there is nothing to wait for. Real unhandled errors still fail the run; nothing is swallowed.
// The real setTimeout is captured now, so a test that stubs the global one cannot make the wait hang.
const realSetTimeout = globalThis.setTimeout;
async function settleFocusScopeTimers() {
  cleanup();
  if (vi.isFakeTimers()) return;
  await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
}
afterEach(settleFocusScopeTimers);
afterAll(settleFocusScopeTimers);
