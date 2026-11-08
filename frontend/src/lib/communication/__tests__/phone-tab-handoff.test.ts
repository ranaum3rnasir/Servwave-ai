// Task B4 — cross-tab dial handoff. A dial request from anywhere in the app
// routes into the SINGLE `/phone` tab (the sole CTM softphone device owner,
// Task A3): the FIRST request opens/navigates a window named
// `servwave-phone` straight to `/phone?dial=<e164>&ctx=<entity context>` — a
// brand-new tab reads the number + context off the URL on mount, so there's
// no boot race on that path. Every SUBSEQUENT request while that tab is
// still open must NEVER re-navigate it (that would drop a live call) —
// instead it broadcasts the new number over BroadcastChannel('servwave-phone')
// and just brings the tab forward. localStorage is a fallback for the boot
// race where the /phone tab hasn't finished mounting its BroadcastChannel
// listener yet when a broadcast dial lands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PHONE_TAB_NAME = 'servwave-phone';
const DIAL_STORAGE_KEY = 'servwave-phone-dial';

const JOB_CONTEXT = {
  jobId: 'b0000000-0000-0000-0000-000000000001',
  jobLabel: 'J00042',
  customerId: 'c0000000-0000-0000-0000-000000000001',
  customerName: 'Daniel Cohen',
};

describe('phoneTabHandoff', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let postMessageSpy: ReturnType<typeof vi.spyOn>;
  let fakeTab: { closed: boolean; focus: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    fakeTab = { closed: false, focus: vi.fn() };
    openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);
    postMessageSpy = vi.spyOn(BroadcastChannel.prototype, 'postMessage');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('first dial opens/navigates a window named servwave-phone with dial + ctx in the URL', async () => {
    const { requestCall } = await import('../phoneTabHandoff');

    requestCall('+15555550199', JOB_CONTEXT);

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, name] = openSpy.mock.calls[0]!;
    expect(name).toBe(PHONE_TAB_NAME);
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.pathname).toBe('/phone');
    expect(parsed.searchParams.get('dial')).toBe('+15555550199');
    expect(JSON.parse(parsed.searchParams.get('ctx')!)).toEqual(JOB_CONTEXT);
  });

  it('a dial with no entity context omits ctx from the URL entirely', async () => {
    const { requestCall } = await import('../phoneTabHandoff');

    requestCall('+15555550199');

    const [url] = openSpy.mock.calls[0]!;
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.searchParams.has('ctx')).toBe(false);
  });

  it('a second dial while the /phone tab is open does NOT re-navigate — it posts + focuses instead', async () => {
    const { requestCall } = await import('../phoneTabHandoff');
    requestCall('+15555550199');
    openSpy.mockClear();

    requestCall('+19294039424', { customerId: 'c-2', customerName: 'Second Caller' });

    // Reuse path: window.open with an EMPTY url + the same tab name — per
    // spec this returns the existing named browsing context WITHOUT
    // navigating it (a non-empty url would drop the live call).
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith('', PHONE_TAB_NAME);
    expect(fakeTab.focus).toHaveBeenCalledTimes(1);

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const posted = postMessageSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(posted).toMatchObject({
      phone: '+19294039424',
      ctx: { customerId: 'c-2', customerName: 'Second Caller' },
    });
  });

  it('the broadcast message carries a null ctx when the second dial has no entity context', async () => {
    const { requestCall } = await import('../phoneTabHandoff');
    requestCall('+15555550199', JOB_CONTEXT);

    requestCall('+19294039424');

    const posted = postMessageSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(posted.ctx).toBeNull();
  });

  it('stashes the subsequent dial to localStorage as a boot-race fallback', async () => {
    const { requestCall } = await import('../phoneTabHandoff');
    requestCall('+15555550199');

    requestCall('+19294039424', { customerId: 'c-2', customerName: 'Second Caller' });

    const stashed = JSON.parse(localStorage.getItem(DIAL_STORAGE_KEY)!);
    expect(stashed).toMatchObject({
      phone: '+19294039424',
      ctx: { customerId: 'c-2', customerName: 'Second Caller' },
    });
  });

  it('re-navigates (treats it as a fresh open) once the previously-opened tab has been closed', async () => {
    const { requestCall } = await import('../phoneTabHandoff');
    requestCall('+15555550199');
    fakeTab.closed = true;
    openSpy.mockClear();

    requestCall('+19294039424');

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, name] = openSpy.mock.calls[0]!;
    expect(name).toBe(PHONE_TAB_NAME);
    expect(url).not.toBe('');
  });
});

// The header dialer button opens the SAME singleton /phone tab as the entity
// Call buttons — just with no number to dial. It must share requestCall's tab
// reference so the two never fight over separate windows.
describe('openPhoneTab', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let fakeTab: { closed: boolean; focus: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    fakeTab = { closed: false, focus: vi.fn() };
    openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);
  });
  afterEach(() => vi.restoreAllMocks());

  it('first call opens /phone (no dial param) in the servwave-phone tab', async () => {
    const { openPhoneTab } = await import('../phoneTabHandoff');

    openPhoneTab();

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, name] = openSpy.mock.calls[0]!;
    expect(name).toBe(PHONE_TAB_NAME);
    const parsed = new URL(url as string, 'http://localhost');
    expect(parsed.pathname).toBe('/phone');
    expect(parsed.searchParams.has('dial')).toBe(false);
  });

  it('does NOT re-navigate an already-open tab — it just focuses it (never drops a live call)', async () => {
    const { openPhoneTab } = await import('../phoneTabHandoff');
    openPhoneTab();
    openSpy.mockClear();

    openPhoneTab();

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith('', PHONE_TAB_NAME);
    expect(fakeTab.focus).toHaveBeenCalledTimes(1);
  });

  it('shares the tab reference with requestCall (open via button, then a dial reuses it)', async () => {
    const { openPhoneTab, requestCall } = await import('../phoneTabHandoff');
    openPhoneTab();
    openSpy.mockClear();

    requestCall('+15555550199');

    // The tab is already open, so requestCall must reuse it (empty-url focus),
    // NOT navigate a fresh window.
    expect(openSpy).toHaveBeenCalledWith('', PHONE_TAB_NAME);
    expect(fakeTab.focus).toHaveBeenCalledTimes(1);
  });

  it('re-opens once the previously-opened tab has been closed', async () => {
    const { openPhoneTab } = await import('../phoneTabHandoff');
    openPhoneTab();
    fakeTab.closed = true;
    openSpy.mockClear();

    openPhoneTab();

    const [url, name] = openSpy.mock.calls[0]!;
    expect(name).toBe(PHONE_TAB_NAME);
    expect(url).not.toBe('');
  });
});
