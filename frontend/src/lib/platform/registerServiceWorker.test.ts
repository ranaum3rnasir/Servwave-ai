import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mobile slice 47: the worker used to be registered by a script the PWA plugin injected into
 * EVERY page's HTML, so a customer opening a public estimate got the staff app's offline cache
 * installed on their phone. Registration now lives here, called only by the staff entry.
 *
 * Mobile slice 67: this module also watches the registration for a waiting update and hands it
 * to the update controller, which never reloads under unsaved work.
 *
 * The module holds the page's one update controller, so each test loads a fresh copy.
 */
const reloadPage = vi.fn();
vi.mock('./reloadPage', () => ({ reloadPage: () => reloadPage() }));

type Listener = () => void;

function fakeWorker(state = 'installed') {
  const listeners: Record<string, Listener[]> = {};
  return {
    state,
    postMessage: vi.fn(),
    addEventListener: (type: string, fn: Listener) => {
      (listeners[type] ??= []).push(fn);
    },
    fire(type: string) {
      (listeners[type] ?? []).forEach((fn) => fn());
    },
  };
}

function fakeRegistration(waiting: ReturnType<typeof fakeWorker> | null = null) {
  const listeners: Record<string, Listener[]> = {};
  return {
    waiting,
    installing: null as ReturnType<typeof fakeWorker> | null,
    update: vi.fn().mockResolvedValue(undefined),
    addEventListener: (type: string, fn: Listener) => {
      (listeners[type] ??= []).push(fn);
    },
    fire(type: string) {
      (listeners[type] ?? []).forEach((fn) => fn());
    },
  };
}

function installServiceWorker(opts: { controller: boolean; registration?: ReturnType<typeof fakeRegistration> }) {
  const containerListeners: Record<string, Listener[]> = {};
  const registration = opts.registration ?? fakeRegistration();
  const register = vi.fn().mockResolvedValue(registration);
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      register,
      controller: opts.controller ? {} : null,
      addEventListener: (type: string, fn: Listener) => {
        (containerListeners[type] ??= []).push(fn);
      },
    },
    configurable: true,
  });
  return {
    register,
    registration,
    fireController(type: string) {
      (containerListeners[type] ?? []).forEach((fn) => fn());
    },
  };
}

function fakeWindow(readyState: string) {
  const listeners: Record<string, () => void> = {};
  const docListeners: Record<string, () => void> = {};
  const win = {
    addEventListener: vi.fn((type: string, fn: () => void) => {
      listeners[type] = fn;
    }),
    setInterval: vi.fn(),
    document: {
      readyState,
      visibilityState: 'visible',
      addEventListener: (type: string, fn: () => void) => {
        docListeners[type] = fn;
      },
    },
  } as unknown as Window;
  return { win, listeners, docListeners };
}

async function load() {
  vi.resetModules();
  const platform = await import('./registerServiceWorker');
  const signal = await import('@/ui-kit/lib/unsavedWork');
  return { ...platform, ...signal };
}

const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
beforeEach(() => {
  reloadPage.mockClear();
});
afterEach(() => {
  if (original) Object.defineProperty(navigator, 'serviceWorker', original);
  else delete (navigator as unknown as Record<string, unknown>).serviceWorker;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('registerServiceWorker', () => {
  it('registers /sw.js at scope / once the page has loaded', async () => {
    const { register } = installServiceWorker({ controller: true });
    const { registerServiceWorker } = await load();
    const { win, listeners } = fakeWindow('loading');

    registerServiceWorker(win);
    expect(register).not.toHaveBeenCalled();
    listeners.load!();
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('registers straight away when the page has already loaded', async () => {
    const { register } = installServiceWorker({ controller: true });
    const { registerServiceWorker } = await load();
    registerServiceWorker(fakeWindow('complete').win);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does nothing where service workers do not exist', async () => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    const { registerServiceWorker } = await load();
    const { win } = fakeWindow('complete');
    expect(() => registerServiceWorker(win)).not.toThrow();
    expect(win.addEventListener).not.toHaveBeenCalled();
  });

  it('swallows a failed registration instead of surfacing an unhandled rejection', async () => {
    const { register } = installServiceWorker({ controller: true });
    register.mockRejectedValue(new Error('blocked'));
    const { registerServiceWorker } = await load();
    registerServiceWorker(fakeWindow('complete').win);
    await flush();
    expect(register).toHaveBeenCalled();
  });
});

describe('update detection (slice 67)', () => {
  it('offers "Update available" when a worker is already waiting at registration', async () => {
    installServiceWorker({ controller: true, registration: fakeRegistration(fakeWorker()) });
    const { registerServiceWorker, updateController } = await load();
    registerServiceWorker(fakeWindow('complete').win);
    await flush();
    expect(updateController.getStatus()).toBe('available');
  });

  it('offers it when a new worker finishes installing while the page is open', async () => {
    const registration = fakeRegistration();
    installServiceWorker({ controller: true, registration });
    const { registerServiceWorker, updateController } = await load();
    registerServiceWorker(fakeWindow('complete').win);
    await flush();
    expect(updateController.getStatus()).toBe('idle');

    const installing = fakeWorker('installing');
    registration.installing = installing;
    registration.fire('updatefound');
    installing.state = 'installed';
    installing.fire('statechange');
    expect(updateController.getStatus()).toBe('available');
  });

  it('does not offer an update for the very first install', async () => {
    installServiceWorker({ controller: false, registration: fakeRegistration(fakeWorker()) });
    const { registerServiceWorker, updateController } = await load();
    registerServiceWorker(fakeWindow('complete').win);
    await flush();
    expect(updateController.getStatus()).toBe('idle');
  });

  it('does not reload when the first install claims a page that had no worker', async () => {
    const sw = installServiceWorker({ controller: false });
    const { registerServiceWorker } = await load();
    registerServiceWorker(fakeWindow('complete').win);
    await flush();
    sw.fireController('controllerchange');
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('applies on tap: posts SKIP_WAITING to the waiting worker, reloads when it takes over', async () => {
    const waiting = fakeWorker();
    const sw = installServiceWorker({ controller: true, registration: fakeRegistration(waiting) });
    const { registerServiceWorker, updateController } = await load();
    registerServiceWorker(fakeWindow('complete').win);
    await flush();

    updateController.requestApply();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reloadPage).not.toHaveBeenCalled();
    sw.fireController('controllerchange');
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('never posts SKIP_WAITING or reloads while the unsaved-work signal is set', async () => {
    const waiting = fakeWorker();
    const sw = installServiceWorker({ controller: true, registration: fakeRegistration(waiting) });
    const { registerServiceWorker, updateController, registerUnsavedWork } = await load();
    registerServiceWorker(fakeWindow('complete').win);
    await flush();

    const clear = registerUnsavedWork('new-task');
    updateController.requestApply();
    sw.fireController('controllerchange');
    expect(waiting.postMessage).not.toHaveBeenCalled();
    expect(reloadPage).not.toHaveBeenCalled();

    clear();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('applies by itself, clean, when the page goes to the background', async () => {
    const waiting = fakeWorker();
    installServiceWorker({ controller: true, registration: fakeRegistration(waiting) });
    const { registerServiceWorker } = await load();
    const { win, docListeners } = fakeWindow('complete');
    registerServiceWorker(win);
    await flush();

    (win.document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    // The controller reads the real document for "hidden"; mirror it there too.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    docListeners.visibilitychange!();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('checks for a newer worker when the page returns to the foreground', async () => {
    const registration = fakeRegistration();
    installServiceWorker({ controller: true, registration });
    const { registerServiceWorker } = await load();
    const { win, docListeners } = fakeWindow('complete');
    registerServiceWorker(win);
    await flush();
    docListeners.visibilitychange!();
    expect(registration.update).toHaveBeenCalledTimes(1);
  });
});
