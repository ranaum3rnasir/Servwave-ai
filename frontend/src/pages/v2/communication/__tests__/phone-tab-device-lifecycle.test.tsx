/// <reference types="@testing-library/jest-dom/vitest" />
// The /phone tab is the ONLY owner of the phone device (Ran, 2026-10-02).
//
// The main-window warm-up that used to boot (and, on logout, tear down) the
// device is gone, so the tab now owns the whole lifecycle:
//   - it boots its own device, on the boot trigger in phoneTabDevice.ts
//     (default: on mount; the first-gesture mode is exercised too);
//   - it destroys that device when the page unmounts;
//   - it destroys it on logout, whether the logout happened in this tab or in
//     another one (the auth listener turns another tab's sign-out into the same
//     store change: isAuthenticated -> false).
//
// Real hook, real singleton (officeSoftphone.ts), real route guard; only the
// vendor device factory is replaced, by a fake whose destroy() we can watch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type FakeDevice = {
  destroy: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  dialFrom: ReturnType<typeof vi.fn>;
  emit: (event: string, payload?: unknown) => void;
};

const { createSpy, devices, bootMode, outbound, myNumbers } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  devices: [] as FakeDevice[],
  // null = the real default trigger; a value forces that mode for one test.
  bootMode: { current: null as null | 'first-gesture' | 'mount' },
  // What /my-outbound-number answers for whoever is signed in right now.
  // `set` also re-renders its readers (the answer arriving late).
  outbound: (() => {
    const listeners = new Set<() => void>();
    const store = {
      current: undefined as undefined | { provider_number_id: string; formatted: string },
      subscribe: (cb: () => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      set: (value: { provider_number_id: string; formatted: string } | undefined) => {
        store.current = value;
        listeners.forEach((cb) => cb());
      },
    };
    return store;
  })(),
  // What /my-numbers answers (the caller-ID picker's choices).
  myNumbers: { current: undefined as undefined | { numbers: Array<Record<string, unknown>> } },
}));

vi.mock('@/lib/communication/ctmSoftphone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/communication/ctmSoftphone')>();
  createSpy.mockImplementation(() => {
    const handlers: Record<string, Array<(p?: unknown) => void>> = {};
    const device = {
      ready: Promise.resolve(),
      call: vi.fn(),
      dialFrom: vi.fn(),
      answer: vi.fn(),
      hangup: vi.fn(),
      mute: vi.fn(),
      on: vi.fn((event: string, cb: (p?: unknown) => void) => {
        (handlers[event] ??= []).push(cb);
        return () => {
          handlers[event] = (handlers[event] ?? []).filter((h) => h !== cb);
        };
      }),
      destroy: vi.fn(),
      emit: (event: string, payload?: unknown) => (handlers[event] ?? []).forEach((cb) => cb(payload)),
    };
    devices.push(device);
    return device;
  });
  return { ...actual, isCtmSoftphoneEnabled: vi.fn(() => true), createCtmSoftphone: createSpy };
});

// A real (tiny) zustand store in place of the global auth mock, so a logout is
// a genuine store change that ProtectedRoute and the page both observe.
vi.mock('@/stores/auth.store', async () => {
  const { create } = await import('zustand');
  const useAuthStore = create(() => ({
    user: {
      id: 'u1',
      organization_id: 'org-1',
      email: 'office@test.com',
      first_name: 'O',
      last_name: 'U',
      role: 'ADMIN',
    },
    isAuthenticated: true,
    isLoading: false,
    error: null,
  }));
  return {
    useAuthStore,
    userDisplayName: () => '',
  };
});

// The real gate, with the trigger forced only when a test asks for a mode.
vi.mock('@/lib/communication/phoneTabDevice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/communication/phoneTabDevice')>();
  return {
    ...actual,
    usePhoneTabBootGate: (enabled: boolean) =>
      actual.usePhoneTabBootGate(enabled, bootMode.current ?? actual.PHONE_TAB_BOOT_TRIGGER),
  };
});

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(() => true),
}));
vi.mock('@/lib/api/communication', () => ({
  BUSINESS_NUMBER: '(551) 282-7064',
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => ({ mutate: vi.fn(), isPending: false }),
  useCallOutcome: () => ({ data: null }),
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
    isPending: false,
  }),
  useCalls: () => ({ data: [] }),
  useDialerSearch: () => ({ data: undefined, isFetching: false }),
}));
vi.mock('@/lib/api/phoneNumbers', () => ({
  requestPhoneAccessToken: vi.fn(() => new Promise(() => {})),
  useMyNumbers: () => ({ data: myNumbers.current }),
}));
vi.mock('@/lib/api/myOutboundNumber', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useMyOutboundNumber: () => ({
      data: useSyncExternalStore(outbound.subscribe, () => outbound.current),
    }),
  };
});

import ProtectedRoute from '@/components/ProtectedRoute';
import PhoneTabPage from '@/pages/v2/communication/PhoneTabPage';
import { getOfficeSoftphone, teardownOfficeSoftphone } from '@/lib/communication/officeSoftphone';
import { useAuthStore } from '@/stores/auth.store';
import { DIAL_STORAGE_KEY, PHONE_TAB_NAME } from '@/lib/communication/phoneTabHandoff';

const signedIn = useAuthStore.getState();

function renderPhoneTab(url = '/phone') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/login" element={<div>Login Screen</div>} />
        <Route path="/" element={<div>Main App Screen</div>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/phone" element={<PhoneTabPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

/** jsdom's window.opener is a plain value; stand in for the opening tab. */
function setOpener(value: unknown) {
  Object.defineProperty(window, 'opener', { configurable: true, writable: true, value });
}

/** Whether a beforeunload fired right now would be blocked by a prompt. */
function unloadPreventedNow() {
  const ev = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

/** A user interaction inside the tab. */
function gestureInTab() {
  act(() => {
    fireEvent.pointerDown(document.body);
  });
}

beforeEach(() => {
  createSpy.mockClear();
  devices.length = 0;
  bootMode.current = null;
  outbound.current = undefined;
  myNumbers.current = undefined;
  localStorage.clear();
  useAuthStore.setState(signedIn, true);
});

afterEach(() => {
  teardownOfficeSoftphone();
  vi.restoreAllMocks();
  setOpener(null);
});

describe('/phone tab - boot trigger', () => {
  it('default: boots its own device on mount, with no gesture (a Call handoff is ready to dial)', () => {
    renderPhoneTab();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(getOfficeSoftphone()).toBe(devices[0]);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText('Click anywhere to start the phone')).not.toBeInTheDocument();
  });

  it("'first-gesture': says honestly that it is waiting for a click, not \"Connecting…\"", () => {
    bootMode.current = 'first-gesture';
    renderPhoneTab();

    expect(createSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Click anywhere to start the phone')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });

  it("'first-gesture': boots once on the first gesture in the tab, then reads \"Connecting…\"", () => {
    bootMode.current = 'first-gesture';
    renderPhoneTab();

    gestureInTab();
    act(() => {
      fireEvent.keyDown(document.body, { key: 'a' });
      fireEvent.pointerDown(document.body);
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText('Click anywhere to start the phone')).not.toBeInTheDocument();
  });
});

describe('/phone tab - device teardown', () => {
  it('destroys its device when the page unmounts', () => {
    const { unmount } = renderPhoneTab();
    expect(devices).toHaveLength(1);

    unmount();

    expect(devices[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(getOfficeSoftphone()).toBeNull();
  });

  it('destroys its device on logout (same tab or another tab - both land as isAuthenticated=false)', () => {
    renderPhoneTab();
    expect(devices).toHaveLength(1);

    act(() => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
    });

    expect(screen.getByText('Login Screen')).toBeInTheDocument();
    expect(devices[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(getOfficeSoftphone()).toBeNull();
  });

  it('destroys its device on logout even when nothing above it unmounts the page', () => {
    // No ProtectedRoute here: the page itself must react to the session ending,
    // not rely on whatever route tree happens to wrap it.
    render(
      <MemoryRouter initialEntries={['/phone']}>
        <PhoneTabPage />
      </MemoryRouter>,
    );
    expect(devices).toHaveLength(1);

    act(() => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
    });

    expect(devices[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(getOfficeSoftphone()).toBeNull();
    // ...and the remounted console never boots a device for nobody.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

// Another tab can sign a different user in over this session without a logout:
// isAuthenticated stays true, but the device (and its token) belong to the
// previous user and possibly another org. Calls must never go out as them.
describe('/phone tab - account switch without logout', () => {
  /** Another tab signing someone in over this session: no logout in between. */
  function signInAs(user: object) {
    useAuthStore.setState({ user, isAuthenticated: true } as never);
  }

  const userB = {
    id: 'u2',
    organization_id: 'org-2',
    email: 'other@test.com',
    first_name: 'B',
    last_name: 'U',
    role: 'ADMIN',
  };

  it("a different user: destroys the previous user's device and boots a fresh one", () => {
    renderPhoneTab();
    expect(devices).toHaveLength(1);
    act(() => devices[0]?.emit('ready'));
    expect(screen.getByText('Ready')).toBeInTheDocument();

    act(() => {
      signInAs(userB);
    });

    expect(devices[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(getOfficeSoftphone()).toBe(devices[1]);
    // The fresh device is still booting - not the old one's "Ready".
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    act(() => devices[1]?.emit('ready'));
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('the same user moved to another org: same treatment', () => {
    renderPhoneTab();

    act(() => {
      signInAs({ ...signedIn.user, organization_id: 'org-9' });
    });

    expect(devices[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(getOfficeSoftphone()).toBe(devices[1]);
  });

  it("B's first call uses B's own default caller ID, not A's", async () => {
    outbound.current = { provider_number_id: 'TPN-A', formatted: '(555) 000-0001' };
    renderPhoneTab();

    outbound.current = { provider_number_id: 'TPN-B', formatted: '(555) 000-0002' };
    act(() => {
      signInAs(userB);
    });
    act(() => devices[1]?.emit('ready'));

    fireEvent.change(screen.getByPlaceholderText('Enter a number'), { target: { value: '+15555550123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() => expect(devices[1]?.call).toHaveBeenCalledTimes(1));
    expect(devices[1]?.dialFrom).toHaveBeenCalledWith('TPN-B');
    expect(devices[1]?.dialFrom).not.toHaveBeenCalledWith('TPN-A');
  });

  it("A's ?dial= number and context are not re-seeded into B's console", () => {
    const ctx = encodeURIComponent(JSON.stringify({ customerId: 'cust-a', customerName: 'Customer A' }));
    renderPhoneTab(`/phone?dial=%2B15550001111&ctx=${ctx}`);
    const dialField = () => screen.getByPlaceholderText('Enter a number') as HTMLInputElement;
    expect(dialField().value).not.toBe('');

    act(() => {
      signInAs(userB);
    });

    expect(dialField().value).toBe('');
    expect(screen.queryByText('Customer A')).not.toBeInTheDocument();
  });

  it('the first sign-in (no previous user, then A) does not tear anything down', () => {
    useAuthStore.setState({ user: null } as never);
    render(
      <MemoryRouter initialEntries={['/phone']}>
        <PhoneTabPage />
      </MemoryRouter>,
    );
    expect(createSpy).not.toHaveBeenCalled();

    act(() => {
      signInAs(signedIn.user as object);
    });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(devices[0]?.destroy).not.toHaveBeenCalled();
    expect(getOfficeSoftphone()).toBe(devices[0]);
  });

  it('the same user refreshed (a new object, same ids): keeps the device', () => {
    renderPhoneTab();

    act(() => {
      signInAs({ ...signedIn.user, first_name: 'Renamed' });
    });

    expect(devices[0]?.destroy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

// "Back to ServWave" navigates THIS tab. During a live call that unmounts the
// page, which destroys the device and drops the call. So while a call is up the
// link brings the main app forward in another tab instead, and the call stays.
describe('/phone tab - "Back to ServWave" never ends a live call', () => {
  function backLink() {
    return screen.getByRole('link', { name: /back to servwave/i });
  }

  it('with no call: navigates this tab to the app, as before', () => {
    renderPhoneTab();

    fireEvent.click(backLink());

    expect(screen.getByText('Main App Screen')).toBeInTheDocument();
  });

  it('during a call: focuses the app tab that opened this one, and keeps the call', () => {
    const opener = { closed: false, focus: vi.fn(), location: { origin: window.location.origin } };
    setOpener(opener);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));

    fireEvent.click(backLink());

    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('Main App Screen')).not.toBeInTheDocument();
    expect(devices[0]?.destroy).not.toHaveBeenCalled();
    expect(devices[0]?.hangup).not.toHaveBeenCalled();
  });

  it('during a call with no opener left: opens the app in a new tab, and keeps the call', () => {
    setOpener(null);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));

    fireEvent.click(backLink());

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]?.[0]).toBe('/');
    expect(screen.queryByText('Main App Screen')).not.toBeInTheDocument();
    expect(devices[0]?.destroy).not.toHaveBeenCalled();
  });

  it('a closed opener counts as no opener', () => {
    const opener = { closed: true, focus: vi.fn(), location: { origin: window.location.origin } };
    setOpener(opener);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));

    fireEvent.click(backLink());

    expect(opener.focus).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('/', '_blank');
  });

  it('an opener on another origin is never focused: the app opens in a new tab instead', () => {
    const opener = { closed: false, focus: vi.fn(), location: { origin: 'https://elsewhere.example' } };
    setOpener(opener);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));

    fireEvent.click(backLink());

    expect(opener.focus).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('/', '_blank');
  });

  it('an opener whose location cannot be read (cross-origin) counts as another origin', () => {
    const opener = {
      closed: false,
      focus: vi.fn(),
      get location(): never {
        throw new DOMException('Blocked a frame with origin', 'SecurityError');
      },
    };
    setOpener(opener);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));

    fireEvent.click(backLink());

    expect(opener.focus).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('/', '_blank');
  });

  it('the toast live region is mounted before any toast, so the first one is announced', () => {
    setOpener(null);
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderPhoneTab();
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('');
    act(() => devices[0]?.emit('start'));

    fireEvent.click(backLink());

    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Your call continues in this tab.');
  });

  it('during a call the click is never dead: the tab says the call continues here', () => {
    setOpener(null);
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));
    expect(screen.queryByText('Your call continues in this tab.')).not.toBeInTheDocument();

    fireEvent.click(backLink());

    expect(screen.getByText('Your call continues in this tab.')).toBeInTheDocument();
  });

  it.each([
    ['cmd-click', { metaKey: true }],
    ['ctrl-click', { ctrlKey: true }],
    ['shift-click', { shiftKey: true }],
    ['middle-click', { button: 1 }],
  ])('during a call a %s is left to the browser (its own new tab/window)', (_name, init) => {
    const opener = { closed: false, focus: vi.fn(), location: { origin: window.location.origin } };
    setOpener(opener);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));

    fireEvent.click(backLink(), init);

    expect(opener.focus).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('Your call continues in this tab.')).not.toBeInTheDocument();
    expect(screen.queryByText('Main App Screen')).not.toBeInTheDocument();
    expect(devices[0]?.destroy).not.toHaveBeenCalled();
  });

  it('after the call ends: back to navigating this tab', () => {
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));
    act(() => devices[0]?.emit('end'));

    fireEvent.click(backLink());

    expect(screen.getByText('Main App Screen')).toBeInTheDocument();
  });

  it("after ServWave's own Hang up: idle at once, even if the device never reports end", () => {
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));

    fireEvent.click(screen.getByRole('button', { name: /hang up/i }));

    expect(devices[0]?.hangup).toHaveBeenCalledTimes(1);
    expect(unloadPreventedNow()).toBe(false);
    fireEvent.click(backLink());
    expect(screen.getByText('Main App Screen')).toBeInTheDocument();
  });

  it('counts a call as live from the moment it is dialled, before the device reports it started', async () => {
    setOpener(null);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPhoneTab();
    act(() => devices[0]?.emit('ready'));

    fireEvent.change(screen.getByPlaceholderText('Enter a number'), { target: { value: '+15555550123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));
    await waitFor(() => expect(devices[0]?.call).toHaveBeenCalledTimes(1));

    fireEvent.click(backLink());

    expect(openSpy).toHaveBeenCalledWith('/', '_blank');
    expect(screen.queryByText('Main App Screen')).not.toBeInTheDocument();
  });
});

// Closing, reloading or browsing this tab away during a live call would drop
// the call, so the browser's "Leave site?" prompt guards it - only while a call
// is live, and never on logout (logging out is meant to end the call).
describe('/phone tab - warns before unload only while a call is live', () => {
  function beforeUnloadListeners() {
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    const pick = (spy: typeof added) =>
      (spy.mock.calls as unknown as Array<[string, unknown]>)
        .filter(([type]) => type === 'beforeunload')
        .map(([, fn]) => fn);
    return {
      added: () => pick(added),
      removed: () => pick(removed),
      /** Listeners added and not yet removed. */
      live: () => pick(added).filter((fn) => !pick(removed).includes(fn)),
    };
  }

  function unloadPrevented() {
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  it('no call: no listener, no prompt', () => {
    const listeners = beforeUnloadListeners();
    renderPhoneTab();

    expect(listeners.added()).toHaveLength(0);
    expect(unloadPrevented()).toBe(false);
  });

  it('during a call: prompts; after the call ends: the listener is removed and there is no prompt', () => {
    const listeners = beforeUnloadListeners();
    renderPhoneTab();

    act(() => devices[0]?.emit('start'));
    expect(listeners.live()).toHaveLength(1);
    expect(unloadPrevented()).toBe(true);

    act(() => devices[0]?.emit('end'));
    expect(listeners.live()).toHaveLength(0);
    expect(unloadPrevented()).toBe(false);
  });

  it('a call that ends just before the page unloads does not prompt (checked when it fires)', () => {
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));

    let prevented: boolean | undefined;
    act(() => {
      devices[0]?.emit('end');
      prevented = unloadPrevented();
    });

    expect(prevented).toBe(false);
  });

  it('unmounting during a call removes the listener', () => {
    const listeners = beforeUnloadListeners();
    const { unmount } = renderPhoneTab();
    act(() => devices[0]?.emit('start'));
    expect(listeners.live()).toHaveLength(1);

    unmount();

    expect(listeners.live()).toHaveLength(0);
    expect(unloadPrevented()).toBe(false);
  });

  it('logout during a call never prompts, even if the page unloads before React re-renders', () => {
    renderPhoneTab();
    act(() => devices[0]?.emit('start'));
    expect(unloadPrevented()).toBe(true);

    // Inside one act() React has not re-rendered yet, so the listener is still
    // attached and the call still live: exactly the window in which a logout
    // that navigates the page programmatically would fire beforeunload.
    let prevented: boolean | undefined;
    act(() => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
      prevented = unloadPrevented();
    });

    expect(prevented).toBe(false);
    expect(devices[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(unloadPrevented()).toBe(false);
  });
});

// What reaches the console when, and what must never reach the next account.
describe('/phone tab - dial handoff', () => {
  const userB = {
    id: 'u2',
    organization_id: 'org-2',
    email: 'other@test.com',
    first_name: 'B',
    last_name: 'U',
    role: 'ADMIN',
  };
  function signInAs(user: object) {
    useAuthStore.setState({ user, isAuthenticated: true } as never);
  }
  const dialField = () => screen.getByPlaceholderText('Enter a number') as HTMLInputElement;

  /** What requestCall does when the tab is already open: channel + stash. */
  function requestCallIntoOpenTab(phone: string) {
    const message = { type: 'dial', phone, ctx: null, ts: Date.now() };
    localStorage.setItem(DIAL_STORAGE_KEY, JSON.stringify(message));
    const ch = new BroadcastChannel(PHONE_TAB_NAME);
    ch.postMessage(message);
    ch.close();
  }

  it('under React.StrictMode the ?dial= number still lands in the field', () => {
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/phone?dial=%2B15550001111']}>
          <PhoneTabPage />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(dialField().value).not.toBe('');
  });

  it("a dial A requested while the tab was open is not replayed into B's console after a switch", async () => {
    renderPhoneTab();
    requestCallIntoOpenTab('+15550002222');
    await waitFor(() => expect(dialField().value).not.toBe(''));

    act(() => {
      signInAs(userB);
    });

    expect(dialField().value).toBe('');
  });

  it('applying the channel copy of a dial removes its stash copy', async () => {
    renderPhoneTab();
    requestCallIntoOpenTab('+15550002222');
    await waitFor(() => expect(dialField().value).not.toBe(''));

    expect(localStorage.getItem(DIAL_STORAGE_KEY)).toBeNull();
  });

  it('a fresh stash (the boot race) is applied on mount and then removed', () => {
    localStorage.setItem(
      DIAL_STORAGE_KEY,
      JSON.stringify({ type: 'dial', phone: '+15550003333', ctx: null, ts: Date.now() }),
    );

    renderPhoneTab();

    expect(dialField().value).not.toBe('');
    expect(localStorage.getItem(DIAL_STORAGE_KEY)).toBeNull();
  });

  it('closes its dial channel when the workspace remounts for another account', () => {
    renderPhoneTab();
    const close = vi.spyOn(BroadcastChannel.prototype, 'close');

    act(() => {
      signInAs(userB);
    });

    expect(close).toHaveBeenCalled();
  });

  it('the empty toast live region is visually hidden (sr-only)', () => {
    renderPhoneTab();

    expect(screen.getByRole('status')).toHaveClass('sr-only');
  });

  it('a default caller ID that arrives after the first render is still taken by the picker', () => {
    myNumbers.current = {
      numbers: [
        { provider_number_id: 'TPN-OTHER', formatted: '(555) 000-0008', is_org_default: true, is_user_default: false },
        { provider_number_id: 'TPN-LATE', formatted: '(555) 000-0009', is_org_default: false, is_user_default: true },
      ],
    };
    renderPhoneTab();
    const picker = screen.getByRole('combobox', { name: /calling from/i });
    expect(picker).not.toHaveTextContent('(555) 000-0009');

    act(() => outbound.set({ provider_number_id: 'TPN-LATE', formatted: '(555) 000-0009' }));

    expect(screen.getByRole('combobox', { name: /calling from/i })).toHaveTextContent('(555) 000-0009');
  });
});
