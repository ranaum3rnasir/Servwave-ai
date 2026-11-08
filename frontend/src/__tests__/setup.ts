import '@testing-library/jest-dom';
import { vi } from 'vitest';
import { configure } from '@testing-library/react';

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
    // Realtime half of the client. Anything that mounts a live subscription
    // (the notification bell, the Inbox message list) touches these on mount,
    // so a mock without them throws inside the effect and fails tests that are
    // not about realtime at all. `channel` is chainable because the real API is
    // (`.on(...).on(...).subscribe()`).
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
if (!global.URL.createObjectURL) {
  global.URL.createObjectURL = vi.fn(() => 'blob:preview');
  global.URL.revokeObjectURL = vi.fn();
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
Object.defineProperty(window, 'matchMedia', {
  writable: true,
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
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.setItem !== 'function') {
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
configure({ asyncUtilTimeout: 20_000 });
