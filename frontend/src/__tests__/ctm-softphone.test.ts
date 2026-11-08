// Slice 4 — the CTM softphone wrapper. Unit-tests OUR adapter (token wiring,
// call/dialFrom proxying, event bridging, teardown) against a fake element.
// The REAL ctm-phone-embed behavior (audio, cross-origin load, exact events) is
// verified in the live two-device QA — this suite guards the seam we control.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createCtmSoftphone,
  isCtmSoftphoneEnabled,
  computeTokenRefreshDelayMs,
  loadCtmEmbedScript,
  type CtmPhoneElement,
} from '@/lib/communication/ctmSoftphone';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A real jsdom element (so addEventListener/dispatchEvent/append/remove are
 *  native) with the CTM methods mocked. */
function makeFakeElement(): CtmPhoneElement & {
  call: ReturnType<typeof vi.fn>;
  answer: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
} {
  const el = document.createElement('div') as any;
  el.call = vi.fn();
  el.answer = vi.fn();
  el.hangup = vi.fn();
  el.mute = vi.fn();
  return el;
}

// Every softphone a test builds is destroyed after it, pass or fail. A live one
// keeps its document/window listeners (the focus guard among them) and would
// steer whichever test runs next. destroy() is safe to call twice.
const liveSoftphones: Array<{ destroy(): void }> = [];

function makeSoftphone(overrides: Record<string, any> = {}) {
  const el = makeFakeElement();
  // The full phone_access payload — the device binds via account_id / user.account.
  const getToken = vi.fn().mockResolvedValue({
    token: 'TKN-123',
    valid_until: 1799999999,
    account_id: '500001',
    user: { account: '500001' },
  });
  const sp = createCtmSoftphone({
    getToken,
    documentRef: document,
    scriptLoader: vi.fn().mockResolvedValue(undefined),
    elementFactory: () => el,
    ...overrides,
  });
  liveSoftphones.push(sp);
  return { sp, el, getToken };
}

beforeEach(() => {
  document.body.innerHTML = '';
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  liveSoftphones.splice(0).forEach((sp) => sp.destroy());
  vi.clearAllMocks();
});

describe('isCtmSoftphoneEnabled', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults ON (WebRTC softphone is the pilot office path now)', () => {
    // The default flipped from OFF → ON for the pilot org. On the
    // staging branch this makes /phone use the real WebRTC device without any
    // per-browser toggle; prod stays on the pre-flip code until promotion.
    expect(isCtmSoftphoneEnabled()).toBe(true);
  });
  it('can be turned off per-browser via the localStorage kill-switch', () => {
    localStorage.setItem('servwave_softphone', 'off');
    expect(isCtmSoftphoneEnabled()).toBe(false);
  });
  it('stays on when explicitly set on', () => {
    localStorage.setItem('servwave_softphone', 'on');
    expect(isCtmSoftphoneEnabled()).toBe(true);
  });
  it('treats an unrecognized localStorage value as the default (on)', () => {
    localStorage.setItem('servwave_softphone', 'maybe');
    expect(isCtmSoftphoneEnabled()).toBe(true);
  });

  // The kill-switch used to live under a key carrying the vendor's name. A
  // browser that already set it must keep its setting, moved to the new key.
  it('honours a kill-switch set under the OLD key, and moves it to the new key', () => {
    localStorage.setItem('ctm_softphone', 'off');

    expect(isCtmSoftphoneEnabled()).toBe(false);
    expect(localStorage.getItem('servwave_softphone')).toBe('off');
    expect(localStorage.getItem('ctm_softphone')).toBeNull();
    // ...and keeps honouring it once moved.
    expect(isCtmSoftphoneEnabled()).toBe(false);
  });
  it('an explicit value under the new key wins over a stale old one', () => {
    localStorage.setItem('servwave_softphone', 'on');
    localStorage.setItem('ctm_softphone', 'off');

    expect(isCtmSoftphoneEnabled()).toBe(true);
    expect(localStorage.getItem('ctm_softphone')).toBeNull();
  });

  it('a build-time VITE_SOFTPHONE=false forces it off', () => {
    vi.stubEnv('VITE_SOFTPHONE', 'false');
    expect(isCtmSoftphoneEnabled()).toBe(false);
  });
  // Deploy settings are outside the repo, so a build that still sets the old,
  // vendor-named variable must keep working until it is renamed there.
  it('still honours the OLD build-time variable as a fallback', () => {
    vi.stubEnv('VITE_CTM_SOFTPHONE', 'false');
    expect(isCtmSoftphoneEnabled()).toBe(false);
  });
  // Vite inlines an empty VITE_SOFTPHONE as "", which is not "unset": with ??
  // it would shadow the old variable. Empty must count as unset.
  it('an EMPTY VITE_SOFTPHONE does not override VITE_CTM_SOFTPHONE=false', () => {
    vi.stubEnv('VITE_SOFTPHONE', '');
    vi.stubEnv('VITE_CTM_SOFTPHONE', 'false');
    expect(isCtmSoftphoneEnabled()).toBe(false);
  });
});

// Everything ServWave itself writes into the page for the phone carries a
// neutral name. Only the vendor's own contract (its script URL, its element
// tag names) may name it.
describe('vendor-neutral markers in the page', () => {
  it('marks its own script tag with a neutral data attribute', async () => {
    void loadCtmEmbedScript(document).catch(() => {});
    const script = document.head.querySelector('script[data-phone-embed]');
    expect(script).not.toBeNull();
    const ourAttributes = Array.from(script!.attributes)
      .map((a) => a.name)
      .filter((n) => n.startsWith('data-'));
    expect(ourAttributes.join(' ')).not.toMatch(/ctm|calltracking/i);
    script!.remove();
  });

  it('re-uses a script tag it already injected instead of adding a second one', async () => {
    void loadCtmEmbedScript(document).catch(() => {});
    void loadCtmEmbedScript(document).catch(() => {});
    expect(document.head.querySelectorAll('script[data-phone-embed]').length).toBe(1);
    document.head.querySelectorAll('script[data-phone-embed]').forEach((n) => n.remove());
  });
});

describe('createCtmSoftphone', () => {
  it('mounts the element inline (no dead mode attr) and defers the token until asked', async () => {
    const { sp, el, getToken } = makeSoftphone();
    await sp.ready;

    // `ready` = script loaded + element mounted. The token is minted on demand —
    // the component asks via ctm:requiresToken — so getToken has NOT run yet.
    expect(document.body.contains(el)).toBe(true);
    expect(el.getAttribute('mode')).toBeNull(); // 'mode' is not a real CTM attribute
    expect(getToken).not.toHaveBeenCalled();
  });

  it('answers ctm:requiresToken by handing the FULL access object to the device, plus exactly the one flag we add', async () => {
    const access = {
      token: 'TKN-123',
      valid_until: 1799999999,
      account_id: '500001',
      user: { account: '500001' },
    };
    const getToken = vi.fn().mockResolvedValue(access);
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;

    // The real component requests a token via this event; the wrapper answers it.
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledTimes(1));

    // The device receives the WHOLE payload (account_id / user) — NOT the bare
    // token string, which dropped the account binding and broke authentication.
    // EXACT equality, spelling out the single field the wrapper adds on the way
    // through (`disableStationCheck` — next case covers why). Exactness is the
    // point in both directions: this fails if anything minted goes MISSING, and
    // equally if an unexpected extra property ever appears in a payload we hand
    // to a third party. A superset match would tolerate the second and is
    // deliberately not used here.
    expect(el.accessToken).toEqual({ ...access, disableStationCheck: true });
    expect(el.accessToken).not.toBe('TKN-123');
  });

  it('stamps disableStationCheck on the object handed to the device', async () => {
    const { sp, el, getToken } = makeSoftphone();
    await sp.ready;

    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledTimes(1));

    // Without it, CTM's 8-hourly microphone "station check" renders a blocking
    // "Check Station to Get Started" screen INSIDE the element we hide at 0x0, so
    // the device never calls bootPhone(), ctm:ready never fires, and the softphone
    // hangs on "Connecting…" behind a button the user cannot see or press.
    expect((el.accessToken as { disableStationCheck?: boolean }).disableStationCheck).toBe(true);
  });

  it('does NOT mutate the caller access object when stamping the flag', async () => {
    const access = {
      token: 'TKN-123',
      valid_until: 1799999999,
      account_id: '500001',
      user: { account: '500001' },
    };
    const getToken = vi.fn().mockResolvedValue(access);
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;

    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.waitFor(() => expect(getToken).toHaveBeenCalledTimes(1));

    // The wrapper reads `access.valid_until` again right after the assignment, and
    // the object belongs to the caller — the flag must land on a COPY.
    expect(Object.prototype.hasOwnProperty.call(access, 'disableStationCheck')).toBe(false);
    expect(el.accessToken).not.toBe(access);
  });

  it('injects hide CSS for the CTM host element so its native panel never renders visibly', async () => {
    const { sp } = makeSoftphone();
    await sp.ready;

    const style = document.getElementById('phone-embed-hide-style');
    expect(style).not.toBeNull();
    expect(style?.tagName).toBe('STYLE');
    expect(style?.textContent).toContain('ctm-phone-embed');
    expect(style?.textContent).toContain('opacity: 0');
    expect(style?.textContent).toContain('pointer-events: none');
    // display:none is NOT used — it can unload the embed's cross-origin iframe
    // and sever the postMessage command/event bridge the wrapper depends on.
    expect(style?.textContent).not.toMatch(/display:\s*none/);
  });

  it('hides the sibling <ctm-device-embed> too — its iframe is full-width and 400px+ tall', async () => {
    const { sp } = makeSoftphone();
    await sp.ready;

    // The device host is appended by VENDOR code after the token authenticates,
    // so nothing we own ever touches that node — the rule has to match by tag
    // name, and it has to already be in the document when the node appears.
    const device = document.createElement('ctm-device-embed');
    document.body.appendChild(device);

    const computed = getComputedStyle(device);
    expect(computed.position).toBe('fixed'); // out of flow: contributes no page height
    expect(computed.width).toBe('0px');
    expect(computed.height).toBe('0px');
    expect(computed.opacity).toBe('0');
    expect(computed.pointerEvents).toBe('none');
    // Same reason as the phone host: display:none risks unloading the iframe —
    // here one holding a live WebRTC session and the microphone.
    expect(computed.display).not.toBe('none');

    device.remove();
  });

  it('does not inject the hide style twice for repeated softphone instances', async () => {
    const { sp: sp1 } = makeSoftphone();
    await sp1.ready;
    const { sp: sp2 } = makeSoftphone();
    await sp2.ready;

    const styles = document.head.querySelectorAll('#phone-embed-hide-style');
    expect(styles.length).toBe(1);
  });

  it('does NOT emit ready on mount — only on the real ctm:ready (mount ≠ device-live)', async () => {
    const { sp, el } = makeSoftphone();
    // Subscribe BEFORE mount resolves so a regression that re-adds a premature
    // mount-time emit('ready') would be caught here.
    const onReady = vi.fn();
    sp.on('ready', onReady);
    await sp.ready;
    expect(onReady).not.toHaveBeenCalled(); // mounting must NOT flip device-live

    el.dispatchEvent(new CustomEvent('ctm:ready', { detail: { agent: { id: 1 } } }));
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('sets the caller ID (dialFrom) then places the call', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;

    sp.dialFrom('TPN-A');
    sp.call('+15551234567');

    expect(el.dialFrom).toEqual({ id: 'TPN-A' });
    expect(el.call).toHaveBeenCalledWith('+15551234567');
  });

  it('bridges CTM element events to stable lifecycle events', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;

    const onStart = vi.fn();
    const onEnd = vi.fn();
    sp.on('start', onStart);
    sp.on('end', onEnd);

    el.dispatchEvent(new CustomEvent('ctm:start', { detail: { sid: 'c1' } }));
    el.dispatchEvent(new CustomEvent('ctm:hangup', { detail: { sid: 'c1' } }));

    expect(onStart).toHaveBeenCalledWith({ sid: 'c1' });
    expect(onEnd).toHaveBeenCalledWith({ sid: 'c1' });
  });

  it('treats ctm:end-activity as the call-end signal (the confirmed inbound terminal event)', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;
    const onEnd = vi.fn();
    sp.on('end', onEnd);

    // The component's message handler emits ctm:end-activity on teardown (ctm:hangup
    // is only its OUTBOUND command) — 'end' must fire off this or the call UI hangs.
    el.dispatchEvent(new CustomEvent('ctm:end-activity', { detail: { sid: 'c1' } }));
    expect(onEnd).toHaveBeenCalledWith({ sid: 'c1' });
  });

  it('proxies mute / hangup / answer to the element', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;

    sp.mute(true);
    sp.hangup();
    sp.answer();

    expect(el.mute).toHaveBeenCalledWith(true);
    expect(el.hangup).toHaveBeenCalledTimes(1);
    expect(el.answer).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes a listener and stops delivering to it', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;
    const cb = vi.fn();
    const off = sp.on('start', cb);
    off();
    el.dispatchEvent(new CustomEvent('ctm:start', { detail: {} }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('destroy removes the element and clears listeners', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;
    const cb = vi.fn();
    sp.on('end', cb);

    sp.destroy();
    expect(document.body.contains(el)).toBe(false);
    // A dangling dispatch after destroy delivers to nobody.
    el.dispatchEvent(new CustomEvent('ctm:hangup', { detail: {} }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('destroy tears down the spawned ctm-device-embed and releases the call (no orphaned mic/WebRTC)', async () => {
    const { sp, el } = makeSoftphone();
    await sp.ready;
    // Simulate the component having authenticated and appended its parent-page
    // WebRTC device as a sibling in the document.
    const device = document.createElement('ctm-device-embed');
    document.body.appendChild(device);

    sp.destroy();

    expect(el.hangup).toHaveBeenCalledTimes(1); // best-effort mic/WebRTC release
    expect(document.body.querySelector('ctm-device-embed')).toBeNull(); // not orphaned
  });

  it('does not mint a token after destroy — a torn-down device is never re-provisioned', async () => {
    const { sp, el, getToken } = makeSoftphone();
    await sp.ready;
    sp.destroy();

    // A late ctm:requiresToken (device reboot racing unmount) must not trigger a
    // mint or touch the dead device — the pre-mint `destroyed || !el` guard holds.
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await Promise.resolve();

    expect(getToken).not.toHaveBeenCalled();
    expect(el.accessToken).toBeUndefined();
  });

  it('emits an error event when token minting fails (no throw escapes)', async () => {
    const getToken = vi.fn().mockRejectedValue(new Error('CTM_TOKEN_FAILED'));
    const { sp, el } = makeSoftphone({ getToken });
    const onError = vi.fn();
    sp.on('error', onError);
    await sp.ready;

    // The failure surfaces when the component asks for a token and getToken rejects.
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });
});

// The CTM softphone token has a short (~10-min) TTL and CTM never refreshes it.
// Left alone, an idle session lets the WebRTC device de-register and the next
// click-to-call eats a reconnect — reintroducing exactly the lag the warm device
// removed. So the wrapper re-mints BEFORE `valid_until` and hands the fresh token
// to the LIVE device in place (Twilio's tokenWillExpire → updateToken pattern),
// which the embed forwards into the running device iframe with no reload — the
// device never de-registers and the UI never shows a reconnect.
describe('computeTokenRefreshDelayMs', () => {
  const NOW = 1_700_000_000_000; // fixed base (ms) so the math is deterministic

  it('re-mints ~90s before a normal ~10-min token expires', () => {
    const validUntil = Math.floor(NOW / 1000) + 600; // epoch seconds, now + 600s
    expect(computeTokenRefreshDelayMs(validUntil, NOW)).toBe(600_000 - 90_000);
  });

  it('clamps an implausibly far-future expiry to the 30-min max (also guards setTimeout overflow)', () => {
    expect(computeTokenRefreshDelayMs(1799999999, NOW)).toBe(30 * 60_000);
  });

  it('floors a near/at-expiry token to a 20s minimum instead of hot-looping', () => {
    const almostGone = Math.floor(NOW / 1000) + 30; // only 30s left (< skew)
    expect(computeTokenRefreshDelayMs(almostGone, NOW)).toBe(20_000);
  });

  it('falls back to a fixed 8-min interval when CTM omits valid_until', () => {
    expect(computeTokenRefreshDelayMs(undefined, NOW)).toBe(8 * 60_000);
    expect(computeTokenRefreshDelayMs(null, NOW)).toBe(8 * 60_000);
    expect(computeTokenRefreshDelayMs('nope', NOW)).toBe(8 * 60_000);
  });
});

describe('createCtmSoftphone — proactive token refresh', () => {
  it('re-mints and hands a fresh token to the LIVE device before valid_until (no requiresToken, no teardown)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const nowSec = Math.floor(Date.now() / 1000);
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', valid_until: nowSec + 600, account_id: '500001', user: { account: '500001' } })
      .mockResolvedValueOnce({ token: 'T2', valid_until: nowSec + 600, account_id: '500001', user: { account: '500001' } });
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;

    // First token (device connect).
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect((el.accessToken as { token: string }).token).toBe('T1');
    // Device-live. Without it the boot watchdog would (correctly) rebuild the
    // device 15s in and add a mint, which is not what this case is measuring —
    // these cases are all about the token handed to an ALREADY-BOOTED device.
    el.dispatchEvent(new CustomEvent('ctm:ready', { detail: {} }));

    // Cross the refresh point (valid_until − 90s ≈ 510s). No ctm:requiresToken and
    // no destroy — the refresh timer alone drives a silent re-mint into the device.
    await vi.advanceTimersByTimeAsync(511_000);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect((el.accessToken as { token: string }).token).toBe('T2');

    sp.destroy();
    vi.useRealTimers();
  });

  it('keeps refreshing across cycles (self-reschedules for the whole session)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const getToken = vi.fn().mockImplementation(() =>
      Promise.resolve({
        token: 'T',
        valid_until: Math.floor(Date.now() / 1000) + 600,
        account_id: 'x',
        user: { account: 'x' },
      }),
    );
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;

    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getToken).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new CustomEvent('ctm:ready', { detail: {} })); // device-live (see above)

    // Three refresh windows → three more mints, each rescheduling the next.
    await vi.advanceTimersByTimeAsync(511_000);
    await vi.advanceTimersByTimeAsync(511_000);
    await vi.advanceTimersByTimeAsync(511_000);
    expect(getToken).toHaveBeenCalledTimes(4);

    sp.destroy();
    vi.useRealTimers();
  });

  it('stops the refresh loop on destroy (no mint after teardown)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const getToken = vi.fn().mockResolvedValue({
      token: 'T1',
      valid_until: Math.floor(Date.now() / 1000) + 600,
      account_id: 'x',
      user: { account: 'x' },
    });
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getToken).toHaveBeenCalledTimes(1);

    sp.destroy();
    await vi.advanceTimersByTimeAsync(30 * 60_000); // well past any refresh point
    expect(getToken).toHaveBeenCalledTimes(1); // the timer was cleared on destroy

    vi.useRealTimers();
  });

  it('still refreshes on the fallback interval when CTM omits valid_until', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', account_id: 'x', user: { account: 'x' } }) // no valid_until
      .mockResolvedValueOnce({ token: 'T2', account_id: 'x', user: { account: 'x' } });
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getToken).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new CustomEvent('ctm:ready', { detail: {} })); // device-live (see above)

    await vi.advanceTimersByTimeAsync(8 * 60_000 + 1000); // past the 8-min fallback
    expect(getToken).toHaveBeenCalledTimes(2);
    expect((el.accessToken as { token: string }).token).toBe('T2');

    sp.destroy();
    vi.useRealTimers();
  });

  it('stamps disableStationCheck on the REFRESHED token too, not just the first mint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const nowSec = Math.floor(Date.now() / 1000);
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', valid_until: nowSec + 600, account_id: 'x', user: { account: 'x' } })
      .mockResolvedValueOnce({ token: 'T2', valid_until: nowSec + 600, account_id: 'x', user: { account: 'x' } });
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;

    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect((el.accessToken as { disableStationCheck?: boolean }).disableStationCheck).toBe(true);
    el.dispatchEvent(new CustomEvent('ctm:ready', { detail: {} })); // device-live (see above)

    // Every re-assignment goes through the same provisionToken path, so a device
    // that reboots off a refreshed token must not land back on the station-check
    // screen. A flag set only on the first mint would leave the refresh path as a
    // silent hole.
    await vi.advanceTimersByTimeAsync(511_000);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect((el.accessToken as { token: string }).token).toBe('T2');
    expect((el.accessToken as { disableStationCheck?: boolean }).disableStationCheck).toBe(true);

    sp.destroy();
    vi.useRealTimers();
  });
});

// CTM's `disableStationCheck` flag (above) is written by the device iframe when it
// RECEIVES ctm:accessGranted, but the gate is evaluated inside the CROSS-ORIGIN
// `phoneapp/embed_device` document (not our-side CtmDeviceEmbed.connectedCallback,
// which only wires a message listener and reads sessionStorage). That document
// reads its localStorage as it parses, before the parent's iframe.onload ever
// posts the message that would refresh the entry. So on a cold
// load whose 8-hour check has lapsed the flag lands one beat too late: the device
// still shows "Check Station to Get Started", still never calls bootPhone(), and
// ctm:ready never fires. The flag only bites on the NEXT device creation — so the
// wrapper forces one, once, if the device has not announced itself in time.
describe('createCtmSoftphone — station-check boot watchdog', () => {
  const TOKEN_TTL_S = 600; // ~10 min: the refresh timer sits at ~510s, far outside
  //                          every window these tests advance through, so nothing
  //                          here can be a token refresh in disguise.

  /** Two tokens back-to-back so a rebuild's re-mint is distinguishable from the
   *  first one purely by what the device ends up holding. */
  function twoTokenSoftphone() {
    const nowSec = Math.floor(Date.now() / 1000);
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', valid_until: nowSec + TOKEN_TTL_S, account_id: 'x', user: { account: 'x' } })
      .mockResolvedValueOnce({ token: 'T2', valid_until: nowSec + TOKEN_TTL_S, account_id: 'x', user: { account: 'x' } })
      .mockResolvedValue({ token: 'T3', valid_until: nowSec + TOKEN_TTL_S, account_id: 'x', user: { account: 'x' } });
    // NB makeSoftphone returns its OWN default mock under the `getToken` key, so
    // the override has to be re-applied on the way out or callers assert on a mock
    // the softphone never used.
    return { ...makeSoftphone({ getToken }), getToken, nowSec };
  }

  /** Stand in for the <ctm-device-embed> the real component appends to the page
   *  once a token authenticates — the node the rescue has to remove (and whose
   *  removal releases the exclusive "ctm.phone.device" Web Lock). */
  function spawnDevice(): HTMLElement {
    const device = document.createElement('ctm-device-embed');
    document.body.appendChild(device);
    return device;
  }

  it('rebuilds the device exactly once when ctm:ready never fires: removes the stale device and re-assigns a fresh token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const { sp, el, getToken } = twoTokenSoftphone();
    await sp.ready;

    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getToken).toHaveBeenCalledTimes(1);
    const stale = spawnDevice();

    // Gated device: it renders CTM's blocking screen inside our 0x0 host and never
    // emits ctm:ready. Cross the watchdog window.
    await vi.advanceTimersByTimeAsync(15_001);

    // The stale device context — the one that resolved the gate against a
    // pre-flag localStorage, and that holds the exclusive device Web Lock — is
    // gone from the document.
    expect(document.body.contains(stale)).toBe(false);
    // …and a fresh access payload was handed over, which is what makes CTM's
    // ensureDeviceEmbed() create a replacement whose connectedCallback finally
    // sees the seeded ctm.stationCheck entry.
    expect(getToken).toHaveBeenCalledTimes(2);
    expect((el.accessToken as { token: string }).token).toBe('T2');

    sp.destroy();
    vi.useRealTimers();
  });

  it('the rebuilt assignment still carries disableStationCheck (the rescue can never hand over an un-flagged payload)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const { sp, el, getToken, nowSec } = twoTokenSoftphone();
    await sp.ready;

    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    spawnDevice();

    await vi.advanceTimersByTimeAsync(15_001);

    // If the rebuild bypassed provisionToken and re-assigned a bare payload, the
    // replacement device would read no flag in its connectedCallback and land
    // straight back on the station-check screen — the rescue would rebuild into
    // the very failure it exists to clear.
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(el.accessToken).toEqual({
      token: 'T2',
      valid_until: nowSec + TOKEN_TTL_S,
      account_id: 'x',
      user: { account: 'x' },
      disableStationCheck: true,
    });

    sp.destroy();
    vi.useRealTimers();
  });

  it('is suppressed by ctm:ready, not by the passage of time (a booted device is never disturbed)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));

    // A device that boots normally: ctm:ready inside the window.
    const booted = twoTokenSoftphone();
    await booted.sp.ready;
    booted.el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    const liveDevice = spawnDevice();
    await vi.advanceTimersByTimeAsync(2_000);
    booted.el.dispatchEvent(new CustomEvent('ctm:ready', { detail: {} }));

    await vi.advanceTimersByTimeAsync(20_000); // well past the window

    // Rebuilding a healthy device would drop its mic + signalling websocket mid-
    // session for no reason.
    expect(document.body.contains(liveDevice)).toBe(true);
    expect(booted.getToken).toHaveBeenCalledTimes(1);
    booted.sp.destroy();

    // Positive control on the identical setup, so this case fails if the watchdog
    // is absent altogether rather than merely correctly suppressed: the ONLY
    // difference below is that ctm:ready never arrives.
    document.body.innerHTML = '';
    const gated = twoTokenSoftphone();
    await gated.sp.ready;
    gated.el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    const staleDevice = spawnDevice();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(document.body.contains(staleDevice)).toBe(false);
    expect(gated.getToken).toHaveBeenCalledTimes(2);

    gated.sp.destroy();
    vi.useRealTimers();
  });

  it('never rebuilds after destroy — a torn-down softphone leaves the page alone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const { sp, el, getToken } = twoTokenSoftphone();
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    spawnDevice();

    sp.destroy(); // before the window elapses — the watchdog is still pending

    // A device belonging to whatever comes next (a remount, the /phone popout).
    // A watchdog that outlived its own softphone would rip it out of the document
    // and mint a token against a dead element.
    const laterDevice = spawnDevice();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(document.body.contains(laterDevice)).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(1);

    // Positive control on the identical setup, so this case fails if the watchdog
    // is absent altogether rather than merely correctly cancelled: the ONLY
    // difference below is that destroy() is never called.
    document.body.innerHTML = '';
    const live = twoTokenSoftphone();
    await live.sp.ready;
    live.el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    const doomed = spawnDevice();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(document.body.contains(doomed)).toBe(false);
    expect(live.getToken).toHaveBeenCalledTimes(2);

    live.sp.destroy();
    vi.useRealTimers();
  });

  it('rebuilds at most once — a later window does not thrash the mic and websocket again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const { sp, el, getToken } = twoTokenSoftphone();
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    spawnDevice();

    await vi.advanceTimersByTimeAsync(15_001); // the one rescue
    expect(getToken).toHaveBeenCalledTimes(2);

    // CTM's ensureDeviceEmbed() creates the replacement. If it too fails to boot,
    // that is not the station check any more and retrying buys nothing — a
    // re-arming watchdog would tear down the mic and the signalling websocket
    // every 15 seconds for the rest of the session. Giving up honestly to the user
    // is a separate change; giving up quietly is the requirement here.
    const rebuilt = spawnDevice();
    await vi.advanceTimersByTimeAsync(15_001 * 3);

    expect(document.body.contains(rebuilt)).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(2);

    sp.destroy();
    vi.useRealTimers();
  });

  it('holds off for the full boot budget — a slow-but-healthy device is not cut off mid-registration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const { sp, el, getToken } = twoTokenSoftphone();
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    const booting = spawnDevice();

    // The real cold chain is four steps — two-hop token mint (with a possibly cold
    // Render dyno), the CloudFront device script, the cross-origin embed_device
    // document and its bundle, then WebRTC registration — and finishes around 11s
    // at its worst. An 8s budget fired INSIDE that, tearing the device out
    // mid-registration and roughly doubling the user's connect time, so the lower
    // bound is pinned here deliberately.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(document.body.contains(booting)).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(1); // no wasted mint either

    // …and it does still fire once the budget is genuinely spent.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(document.body.contains(booting)).toBe(false);
    expect(getToken).toHaveBeenCalledTimes(2);

    sp.destroy();
    vi.useRealTimers();
  });

  it('a rebooting device asking for its token does not trigger another rebuild', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const { sp, el, getToken } = twoTokenSoftphone();
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    spawnDevice();

    await vi.advanceTimersByTimeAsync(15_001); // the one rescue
    const replacement = spawnDevice(); // what CTM's ensureDeviceEmbed() creates

    // A freshly built device asks for a token as it connects — that is the normal
    // reactive path and it must stay a plain re-assignment. If the rescue ever
    // leaked into this handler, every device reboot would tear the page's device
    // out from under itself.
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.body.contains(replacement)).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(15_001 * 3);
    expect(document.body.contains(replacement)).toBe(true);
    expect(getToken).toHaveBeenCalledTimes(3);

    sp.destroy();
    vi.useRealTimers();
  });

  it('a ctm:ready landing mid-mint cancels the rescue — the booted device is not replaced', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const nowSec = Math.floor(Date.now() / 1000);
    let releaseMint!: (payload: unknown) => void;
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', valid_until: nowSec + 600, account_id: 'x', user: { account: 'x' } })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseMint = resolve; }));
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    const device = spawnDevice();

    // Deadline reached: the rescue starts and blocks on its mint.
    await vi.advanceTimersByTimeAsync(15_001);
    expect(getToken).toHaveBeenCalledTimes(2);

    // ctm:ready arrives as a window postMessage relayed by the phone-embed's own
    // handler, which outlives device removal — so one already in flight lands just
    // after the pre-mint guard passed. Only the post-await re-check can catch it.
    el.dispatchEvent(new CustomEvent('ctm:ready', { detail: {} }));
    releaseMint({ token: 'T2', valid_until: nowSec + 600, account_id: 'x', user: { account: 'x' } });
    await vi.advanceTimersByTimeAsync(0);

    // The device that just announced itself is still the live one, still holding
    // its own token. Assigning T2 here would have built a THIRD device.
    expect(document.body.contains(device)).toBe(true);
    expect((el.accessToken as { token: string }).token).toBe('T1');

    sp.destroy();
    vi.useRealTimers();
  });

  it('a failed rescue destroys nothing, retries once, then stops for good (no 409 loop)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const nowSec = Math.floor(Date.now() / 1000);
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: 'T1', valid_until: nowSec + 600, account_id: 'x', user: { account: 'x' } })
      // A `phone`-entitled org with no linked account 409s on every single mint.
      .mockRejectedValue(new Error('CTM_NOT_CONNECTED'));
    const { sp, el } = makeSoftphone({ getToken });
    const onError = vi.fn();
    sp.on('error', onError);
    await sp.ready;
    el.dispatchEvent(new CustomEvent('ctm:requiresToken', {}));
    await vi.advanceTimersByTimeAsync(0);
    const device = spawnDevice();

    // Attempt 1 fails. Because the mint runs BEFORE the teardown, the existing
    // device is untouched — the old ordering left the page with no device at all
    // until the refresh timer fired up to ~510s later.
    await vi.advanceTimersByTimeAsync(15_001);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(document.body.contains(device)).toBe(true);

    // One retry, then permanent stop.
    await vi.advanceTimersByTimeAsync(15_001);
    expect(getToken).toHaveBeenCalledTimes(3);

    // The loop the attempt cap exists to prevent: re-arming on every failure would
    // 409 for ever and re-raise the connect banner via emit('error') each time.
    await vi.advanceTimersByTimeAsync(15_001 * 8);
    expect(getToken).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(document.body.contains(device)).toBe(true);
    // "Stopped" means no watchdog timer is left pending either — a re-arm that
    // merely no-ops in the rescue would still spin a timer every 15s for the whole
    // session. The one surviving timer is the token refresh (~510s out, untouched
    // by the failed mints).
    expect(vi.getTimerCount()).toBe(1);

    sp.destroy();
    vi.useRealTimers();
  });
});

// Slice 3 — making the remaining boot failures legible. The watchdog above can
// rescue ONE cause; everything else it cannot fix used to render as an eternal
// "Connecting…". These cases cover the two vendor signals our page can actually
// hear (verified against the shipped bundles — see the comment block above
// CTM_MESSAGE_ORIGIN in ctmSoftphone.ts), the origin check that keeps a hostile
// page from forging them, listener teardown, and the rescue suppression that
// stops a lock loser from burning a token mint it can never use.
describe('createCtmSoftphone — boot fault reporting', () => {
  const CTM_ORIGIN = 'https://app.calltrackingmetrics.com';
  const FAULT_DEADLINE_MS = 40_000; // BOOT_FAULT_DEADLINE_MS

  /** Post exactly what the vendor's device iframe posts to `window.parent`:
   *  a bare `{action}` object, broadcast with targetOrigin "*". */
  function postFromDevice(action: string, origin: string = CTM_ORIGIN) {
    window.dispatchEvent(new MessageEvent('message', { data: { action }, origin }));
  }

  /** Stand in for the <ctm-device-embed> the component appends once a token
   *  authenticates — the node a rescue would tear out. */
  function spawnDevice(): HTMLElement {
    const device = document.createElement('ctm-device-embed');
    document.body.appendChild(device);
    return device;
  }

  it('reports locked-out the instant the device says it lost the tab lock — nothing left to wait for', async () => {
    const { sp } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    postFromDevice('ctm.device.locked_out');

    expect(onFault).toHaveBeenCalledWith('locked-out');
    sp.destroy();
  });

  it('blames the audio check when the device entered boot but never cleared the gate', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    // Won the lock, so boot() ran. The vendor posts inline_ready only at the END
    // of its station-check handler, so its absence IS the blocked gate.
    postFromDevice('ctm.device.locked_in');
    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS + 1);

    expect(onFault).toHaveBeenCalledWith('station-check');
    sp.destroy();
    vi.useRealTimers();
  });

  it('does NOT blame the audio check once the device has cleared it — that is an unclassifiable hang', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    postFromDevice('ctm.device.locked_in');
    postFromDevice('ctm.device.inline_ready'); // mic gate passed, device registered
    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS + 1);

    expect(onFault).toHaveBeenCalledWith('unknown');
    sp.destroy();
    vi.useRealTimers();
  });

  it('says "unknown" rather than guessing when the device said nothing at all', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS + 1);

    expect(onFault).toHaveBeenCalledWith('unknown');
    sp.destroy();
    vi.useRealTimers();
  });

  it('holds "Connecting…" for the whole budget — a slow-but-healthy boot is never accused', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS - 1);
    expect(onFault).not.toHaveBeenCalled();

    sp.destroy();
    vi.useRealTimers();
  });

  it('never faults a device that booted — ctm:ready stands the deadline down', async () => {
    vi.useFakeTimers();
    const { sp, el } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    el.dispatchEvent(new CustomEvent('ctm:ready'));
    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS * 3);

    expect(onFault).not.toHaveBeenCalled();
    sp.destroy();
    vi.useRealTimers();
  });

  it('reports at most one fault per device, however long it stays broken', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    postFromDevice('ctm.device.locked_out');
    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS * 3);
    postFromDevice('ctm.device.locked_out');

    expect(onFault).toHaveBeenCalledTimes(1);
    sp.destroy();
    vi.useRealTimers();
  });

  // ─── The embed script never arriving ──────────────────────────────────────
  // Both halves matter and they are different failure modes: a load that REJECTS
  // (blocked by an ad-blocker / proxy / CSP — a call-tracking host is squarely on
  // privacy blocklists) and a load that never settles at all. Neither used to
  // raise anything: the fault deadline was armed as the LAST statement of the
  // construction IIFE, downstream of `await load()`, so both left the dialer on
  // "Connecting…" for ever — the exact bug this file exists to prevent.
  it('raises a fault immediately when the embed script cannot load — not after a wait', async () => {
    vi.useFakeTimers();
    const scriptLoader = vi.fn().mockRejectedValue(new Error('blocked'));
    const { sp } = makeSoftphone({ scriptLoader });
    const onFault = vi.fn();
    const onError = vi.fn();
    sp.on('fault', onFault);
    sp.on('error', onError);

    await sp.ready;

    // No timer has been advanced: the fault is raised by the rejection itself,
    // because a blocked script is terminal and there is nothing left to wait for.
    expect(onError).toHaveBeenCalled();
    expect(onFault).toHaveBeenCalledWith('unknown');

    sp.destroy();
    vi.useRealTimers();
  });

  it('still raises a fault when the embed script load never settles at all', async () => {
    vi.useFakeTimers();
    // Appended, network hangs, no load AND no error event — ever. The .catch
    // above can never run, so only a deadline armed at CONSTRUCTION covers this.
    const scriptLoader = vi.fn(() => new Promise<void>(() => {}));
    const { sp } = makeSoftphone({ scriptLoader });
    const onFault = vi.fn();
    sp.on('fault', onFault);

    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS + 1);

    expect(onFault).toHaveBeenCalledWith('unknown');

    sp.destroy();
    vi.useRealTimers();
  });

  // ─── Origin validation ────────────────────────────────────────────────────
  // Both vendor bundles broadcast with targetOrigin "*", so the payloads are not
  // addressed to us in any enforceable sense. Any page holding a handle to our
  // window could post the same bytes. `event.origin` is the whole boundary.
  it('ignores a locked_out forged by a foreign origin — and the rescue it would have suppressed still runs', async () => {
    vi.useFakeTimers();
    const { sp, getToken } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);
    const stale = spawnDevice();

    postFromDevice('ctm.device.locked_out', 'https://evil.example.com');
    expect(onFault).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_001);
    expect(document.body.contains(stale)).toBe(false); // rescue unaffected
    expect(getToken).toHaveBeenCalledTimes(1);

    // …and what eventually lands is the honest 'unknown', never the forged claim.
    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS);
    expect(onFault).toHaveBeenCalledWith('unknown');
    expect(onFault).not.toHaveBeenCalledWith('locked-out');

    sp.destroy();
    vi.useRealTimers();
  });

  it('ignores a locked_out from an origin that merely LOOKS like the phone service', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    // The check has to be equality against the exact origin. A substring or
    // suffix test would accept every one of these, and registering a lookalike
    // host is the cheapest attack there is.
    for (const origin of [
      'https://app.calltrackingmetrics.com.evil.example',
      'https://evil-calltrackingmetrics.com',
      'http://app.calltrackingmetrics.com',
      'https://app.calltrackingmetrics.com:8443',
    ]) {
      postFromDevice('ctm.device.locked_out', origin);
    }

    expect(onFault).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS + 1);
    expect(onFault).toHaveBeenCalledWith('unknown');
    expect(onFault).not.toHaveBeenCalledWith('locked-out');

    sp.destroy();
    vi.useRealTimers();
  });

  it('ignores a locked_in forged by a foreign origin — a hostile page cannot steer the diagnosis', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    // Accepted, this would flip the classification from 'unknown' to
    // 'station-check' and send the user chasing a microphone that is fine.
    postFromDevice('ctm.device.locked_in', 'https://evil.example.com');
    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS + 1);

    expect(onFault).toHaveBeenCalledWith('unknown');
    expect(onFault).not.toHaveBeenCalledWith('station-check');
    sp.destroy();
    vi.useRealTimers();
  });

  it('takes its window listener off on destroy — the exact handler it added', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const { sp } = makeSoftphone();
    await sp.ready;
    const added = addSpy.mock.calls.find(([type]) => type === 'message');
    expect(added).toBeDefined();

    sp.destroy();

    // The SAME reference comes back off. A fresh closure here would look like
    // cleanup and leave the real listener attached for the page's lifetime.
    expect(removeSpy).toHaveBeenCalledWith('message', added![1]);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('raises nothing after destroy, however the device is behaving', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const onFault = vi.fn();
    sp.on('fault', onFault);

    sp.destroy();
    postFromDevice('ctm.device.locked_out');
    await vi.advanceTimersByTimeAsync(FAULT_DEADLINE_MS * 3);

    expect(onFault).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // ─── Rescue suppression (the /phone popout case) ──────────────────────────
  // A /phone popout opened beside the main app ALWAYS loses the exclusive
  // "ctm.phone.device" lock, so the watchdog used to fire 100% of the time and
  // burn a token mint rebuilding a device that could only lose the same lock
  // again. A lock loser does not need rebuilding; it needs the honest message.
  it('does not rebuild a device that lost the tab lock — no wasted mint, nothing torn out', async () => {
    vi.useFakeTimers();
    const { sp, getToken } = makeSoftphone();
    await sp.ready;
    const stale = spawnDevice();

    postFromDevice('ctm.device.locked_out');
    await vi.advanceTimersByTimeAsync(15_001);

    expect(getToken).not.toHaveBeenCalled();
    expect(document.body.contains(stale)).toBe(true);

    sp.destroy();
    vi.useRealTimers();
  });

  it('withdraws a rescue already in flight when the lock loss lands mid-mint', async () => {
    vi.useFakeTimers();
    let release!: (v: unknown) => void;
    const getToken = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const { sp, el } = makeSoftphone({ getToken });
    await sp.ready;
    const stale = spawnDevice();

    // The rescue fires and parks on the mint (mint FIRST, tear down LAST).
    await vi.advanceTimersByTimeAsync(15_001);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(document.body.contains(stale)).toBe(true);

    // The device only now resolves its lock — and lost.
    postFromDevice('ctm.device.locked_out');
    release({ token: 'T2', valid_until: 1799999999, account_id: 'x', user: { account: 'x' } });
    await vi.advanceTimersByTimeAsync(0);

    expect(document.body.contains(stale)).toBe(true); // withdrawn, not rebuilt
    expect(el.accessToken).toBeUndefined(); // and the minted token never applied

    sp.destroy();
    vi.useRealTimers();
  });

  it('leaves the rescue alone for every other cause — a silent device is still rebuilt', async () => {
    vi.useFakeTimers();
    const { sp, getToken } = makeSoftphone();
    await sp.ready;
    const stale = spawnDevice();

    // locked_in, not locked_out: the device holds the lock, it is just stuck.
    postFromDevice('ctm.device.locked_in');
    await vi.advanceTimersByTimeAsync(15_001);

    expect(document.body.contains(stale)).toBe(false);
    expect(getToken).toHaveBeenCalledTimes(1);

    sp.destroy();
    vi.useRealTimers();
  });
});

// ─── Focus guard (the dialer losing its number field) ─────────────────────────
// The vendor panel focuses its own phone-number input while it boots, with no
// user gesture. The panel is hidden and never meant to be used, so the focus
// belongs back where the user had it. Chrome only honours that hand-back on the
// NEXT task, so the guard must defer it; a synchronous refocus looks fine here in
// jsdom but lands 0 digits in a real browser. The tests below therefore assert
// that nothing moves synchronously, and only after the timer fires.
describe('createCtmSoftphone — focus guard', () => {
  /** A vendor host (real tag name, so the guard's selector is under test) with
   *  a focusable control inside it, standing in for the vendor's own input. */
  function vendorHostWithInput(tag: 'ctm-phone-embed' | 'ctm-device-embed') {
    const host = document.createElement(tag) as unknown as CtmPhoneElement;
    const vendorInput = document.createElement('input');
    vendorInput.setAttribute('data-testid', 'vendor-input');
    host.appendChild(vendorInput);
    return { host, vendorInput };
  }

  function dialField() {
    const input = document.createElement('input');
    input.setAttribute('data-testid', 'dial-number');
    document.body.appendChild(input);
    return input;
  }

  /** What Chrome does when the vendor frame grabs focus: the frame's element
   *  becomes active in our document and our window receives `blur`. */
  function vendorSteals(vendorInput: HTMLElement) {
    vendorInput.focus();
    window.dispatchEvent(new Event('blur'));
  }

  afterEach(() => vi.useRealTimers());

  // Both hosts: the phone embed we mount, and the device embed the vendor
  // appends to the body on its own.
  it.each(['ctm-phone-embed', 'ctm-device-embed'] as const)(
    'hands focus back to the dial field on the next task, never synchronously (%s)',
    async (tag) => {
      vi.useFakeTimers();
      const { host, vendorInput } = vendorHostWithInput(tag);
      const { sp } = makeSoftphone(tag === 'ctm-phone-embed' ? { elementFactory: () => host } : {});
      await sp.ready;
      if (tag === 'ctm-device-embed') document.body.appendChild(host);
      const dial = dialField();
      dial.focus();

      vendorSteals(vendorInput);
      // Still stolen right after the blur: a synchronous refocus fails in Chrome.
      expect(document.activeElement).toBe(vendorInput);

      vi.advanceTimersByTime(0);
      expect(document.activeElement).toBe(dial);
    },
  );

  it('hands focus back to a field that was focused BEFORE the softphone was built', async () => {
    // The /phone dialer autofocuses its number field during React's commit,
    // before the effect that builds the softphone runs, so no focusin is ever
    // seen for it. The guard has to start from whatever already holds focus.
    vi.useFakeTimers();
    const dial = dialField();
    dial.focus();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;

    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(dial);
  });

  // The vendor frames sit at the end of <body>, so Tab walks into them off
  // either end of the page. Bouncing that back to the control pinned Tab on it
  // for good, and a plain blur left Chrome restarting from the frame; instead the
  // walk-off wraps to our first control (forward) or our last (backward).
  const press = (target: HTMLElement, key: string, shiftKey = false) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));

  /** jsdom lays nothing out, so every element reports zero client rects. Stand
   *  in for layout: anything under a [hidden] subtree is unrendered, the rest is
   *  rendered (or, with `nothing`, the whole page is unrendered). */
  let layoutSpy: { mockRestore(): void } | null = null;
  const fakeLayout = (nothing = false) => {
    layoutSpy = vi
      .spyOn(Element.prototype, 'getClientRects')
      .mockImplementation(function (this: Element) {
        const rendered = !nothing && !this.closest('[hidden]');
        return (rendered ? [{}] : []) as unknown as DOMRectList;
      });
  };
  afterEach(() => {
    layoutSpy?.mockRestore(); // even when an assertion threw first
    layoutSpy = null;
  });

  it('wraps a forward Tab off the last control to the first tabbable control, skipping the untabbable', async () => {
    // Blurring to the document is not enough: Chrome keeps its Tab starting
    // point at the vendor frame, so every next Tab walked straight back in.
    vi.useFakeTimers();
    fakeLayout();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;

    // Ahead of the real first control, in document order, every kind of thing
    // that must be skipped.
    const ahead = document.createElement('div');
    const disabled = document.createElement('button');
    disabled.disabled = true;
    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'hidden';
    const untabbable = document.createElement('div');
    untabbable.tabIndex = -1;
    const unrendered = document.createElement('div');
    unrendered.hidden = true;
    unrendered.appendChild(document.createElement('button'));
    const inertSection = document.createElement('section');
    inertSection.setAttribute('inert', '');
    inertSection.appendChild(document.createElement('button'));
    const vendorAhead = vendorHostWithInput('ctm-device-embed').host;
    ahead.append(disabled, hiddenInput, untabbable, unrendered, inertSection, vendorAhead);
    document.body.prepend(ahead);
    const firstControl = document.createElement('a');
    firstControl.href = '#top';
    firstControl.textContent = 'Home';
    ahead.after(firstControl);
    const lastKey = dialField();
    lastKey.focus();

    press(lastKey, 'Tab');
    vendorSteals(vendorInput);
    expect(document.activeElement).toBe(vendorInput); // deferred, like every hand-back
    vi.advanceTimersByTime(0);

    expect(document.activeElement).toBe(firstControl);
  });

  it('falls back to the document when nothing on the page is tabbable', async () => {
    vi.useFakeTimers();
    fakeLayout(true);
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const lastKey = dialField();
    lastKey.focus();

    press(lastKey, 'Tab');
    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);

    expect(document.activeElement).not.toBe(lastKey);
    expect(document.activeElement).toBe(document.body);
  });

  it('still hands focus back after a stale Tab either way, or a Tab followed by typing', async () => {
    vi.useFakeTimers();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const dial = dialField();

    const stealAndSettle = () => {
      vendorSteals(vendorInput);
      vi.advanceTimersByTime(0);
    };

    dial.focus();
    press(dial, 'Tab');
    vi.advanceTimersByTime(2_000); // the boot steal, long after the Tab
    stealAndSettle();
    expect(document.activeElement).toBe(dial);

    press(dial, 'Tab', true);
    vi.advanceTimersByTime(2_000); // …and long after a Shift+Tab
    stealAndSettle();
    expect(document.activeElement).toBe(dial);

    press(dial, 'Tab');
    press(dial, '5'); // the last key is a digit, not the Tab
    stealAndSettle();
    expect(document.activeElement).toBe(dial);

    press(dial, 'Tab', true);
    press(dial, '5');
    stealAndSettle();
    expect(document.activeElement).toBe(dial);
  });

  it('wraps a Shift+Tab off the top to the LAST tabbable control, skipping the untabbable after it', async () => {
    // The vendor frame sits at the end of <body>, so a backward wrap off the
    // first control lands in it. The user is walking backwards off the top:
    // they belong on our last control, not the field they started from.
    vi.useFakeTimers();
    fakeLayout();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const firstKey = dialField();
    const lastControl = document.createElement('button');
    lastControl.textContent = 'End call';
    document.body.appendChild(lastControl);
    // After the real last control, in document order, everything to skip.
    const behind = document.createElement('div');
    const disabled = document.createElement('button');
    disabled.disabled = true;
    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'hidden';
    const untabbable = document.createElement('div');
    untabbable.tabIndex = -1;
    const unrendered = document.createElement('div');
    unrendered.hidden = true;
    unrendered.appendChild(document.createElement('button'));
    const inertSection = document.createElement('section');
    inertSection.setAttribute('inert', '');
    inertSection.appendChild(document.createElement('button'));
    const vendorBehind = vendorHostWithInput('ctm-device-embed').host;
    behind.append(disabled, hiddenInput, untabbable, unrendered, inertSection, vendorBehind);
    document.body.appendChild(behind);
    firstKey.focus();

    press(firstKey, 'Tab', true);
    vendorSteals(vendorInput);
    expect(document.activeElement).toBe(vendorInput); // deferred, like every hand-back
    vi.advanceTimersByTime(0);

    expect(document.activeElement).toBe(lastControl);
  });

  it('takes the direction from the LATEST Tab: Shift+Tab, then a forward walk-off, wraps to the first control', async () => {
    vi.useFakeTimers();
    fakeLayout();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const firstControl = document.createElement('a');
    firstControl.href = '#top';
    document.body.prepend(firstControl);
    const lastKey = dialField();
    const lastControl = document.createElement('button');
    document.body.appendChild(lastControl);
    lastKey.focus();

    press(lastKey, 'Tab', true); // an earlier backward step inside the page
    vi.advanceTimersByTime(2_000);
    press(lastKey, 'Tab'); // …then forward off the end
    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);

    expect(document.activeElement).not.toBe(lastControl);
    expect(document.activeElement).toBe(firstControl);
  });

  it('falls back to the document on a Shift+Tab walk-off when nothing is tabbable, never the remembered field', async () => {
    vi.useFakeTimers();
    fakeLayout(true);
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const firstKey = dialField();
    firstKey.focus();

    press(firstKey, 'Tab', true);
    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);

    expect(document.activeElement).not.toBe(firstKey);
    expect(document.activeElement).toBe(document.body);
  });

  it('moves nothing on a real tab switch, wherever focus sits and even straight after a Tab', async () => {
    vi.useFakeTimers();
    const { host } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const dial = dialField();
    const notes = document.createElement('textarea');
    document.body.appendChild(notes);

    // Focused in the dial field, typing in the notes, then nothing focused.
    dial.focus();
    notes.focus();
    notes.blur();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(document.body);

    // And with the notes still focused, the blur leaves them exactly there.
    notes.focus();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(notes);

    // Tab onto a field, then switch away inside the Tab window: the forward-Tab
    // rule is for focus that landed in the vendor panel, never for our own field.
    press(notes, 'Tab');
    dial.focus();
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(dial);

    // Focus on something the guard does not remember (a focusable SVG chart):
    // a tab switch from there must not pull focus back to the older field.
    vi.advanceTimersByTime(1_000); // well past the Tab above
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chart.setAttribute('tabindex', '0');
    document.body.appendChild(chart);
    chart.focus();
    expect(document.activeElement).toBe(chart);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(chart);
  });

  it('blurs the vendor control when the field it stole from is gone', async () => {
    vi.useFakeTimers();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const dial = dialField();
    dial.focus();
    dial.remove(); // e.g. the dialer re-rendered between the click and the steal

    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);

    expect(document.activeElement).not.toBe(vendorInput);
    expect(document.activeElement).toBe(document.body);
  });

  it('forgets a field found detached, so it is not resurrected if it comes back', async () => {
    vi.useFakeTimers();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const dial = dialField();
    dial.focus();
    dial.remove();

    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(document.body);

    // The same node re-attached later (a cached subtree, say) was never chosen
    // by the user again; the next steal must not hand focus to it.
    document.body.appendChild(dial);
    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(document.body);
  });

  it('blurs the vendor control when the remembered field can no longer take focus', async () => {
    vi.useFakeTimers();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const dial = dialField();
    dial.focus();
    dial.disabled = true; // still in the page, but focus() on it is now a no-op

    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);

    expect(document.activeElement).not.toBe(vendorInput);
    expect(document.activeElement).toBe(document.body);
  });

  // Leaving a field for nowhere (a click on blank space) is a deliberate choice:
  // a later steal must not drag focus back into that field, possibly off screen.
  // A tab switch and the steal itself also fire focusout with no relatedTarget,
  // but leave focus on the field / the vendor frame, so those keep it.
  const focusOutToNowhere = (from: HTMLElement) =>
    from.dispatchEvent(new FocusEvent('focusout', { relatedTarget: null, bubbles: true }));

  it('forgets a field the user left for blank space', async () => {
    vi.useFakeTimers();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const poSearch = dialField();
    poSearch.focus();
    poSearch.blur(); // click on blank panel: focus goes to body, no focusin
    vi.advanceTimersByTime(0);

    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);

    expect(document.activeElement).not.toBe(poSearch);
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps the field across a tab switch, then hands it back after a steal', async () => {
    vi.useFakeTimers();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const dial = dialField();
    dial.focus();

    // Tab switch: the field fires focusout to nowhere but stays activeElement.
    focusOutToNowhere(dial);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(dial);

    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(dial);
  });

  it('keeps the field when the steal itself reports focus leaving to nowhere', async () => {
    // A cross-origin frame taking focus fires focusout with relatedTarget null
    // and activeElement reading body at that moment, then the frame gets focus,
    // all in one task. Judging "left for nowhere" right then would forget the
    // field; judged on the next task (before the hand-back) it is kept.
    vi.useFakeTimers();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const dial = dialField();
    dial.focus();

    dial.blur(); // focusout, relatedTarget null, activeElement = body
    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(dial);
  });

  it('hands focus back when the window regains focus after a steal it never heard about', async () => {
    // A recurring vendor grab while the tab is in the background reaches us as
    // no blur at all; coming back to the tab must not leave typing in the panel.
    vi.useFakeTimers();
    const { host, vendorInput } = vendorHostWithInput('ctm-phone-embed');
    const { sp } = makeSoftphone({ elementFactory: () => host });
    await sp.ready;
    const dial = dialField();
    dial.focus();

    vendorInput.focus(); // the background steal: no window blur follows
    window.dispatchEvent(new Event('focus'));
    expect(document.activeElement).toBe(vendorInput); // deferred, like the blur path

    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(dial);
  });

  it('stops guarding once destroyed', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const dial = dialField();
    dial.focus();
    sp.destroy();

    // destroy() removes the vendor hosts, so stand one back up to steal with.
    const { host, vendorInput } = vendorHostWithInput('ctm-device-embed');
    document.body.appendChild(host);
    vendorSteals(vendorInput);
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(vendorInput);
  });

  it('drops a hand-back that was already queued when destroy() ran', async () => {
    vi.useFakeTimers();
    const { sp } = makeSoftphone();
    await sp.ready;
    const dial = dialField();
    dial.focus();
    const { host, vendorInput } = vendorHostWithInput('ctm-device-embed');
    document.body.appendChild(host);

    vendorSteals(vendorInput); // queues the hand-back
    sp.destroy();
    // destroy() tore the host out; put it back, re-steal, and let the queued
    // timer fire. Nothing may move: the guard belongs to a dead softphone.
    document.body.appendChild(host);
    vendorInput.focus();
    vi.advanceTimersByTime(0);
    expect(document.activeElement).toBe(vendorInput);
  });

  it('takes every focus-guard listener off on destroy, so they never stack across softphones', async () => {
    // The steal tests above stay green on a leaked listener (the timer also
    // checks `destroyed`), so the teardown is pinned here: the SAME references
    // that went on must come off, with the same capture flag on the document.
    const winAdd = vi.spyOn(window, 'addEventListener');
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const docAdd = vi.spyOn(document, 'addEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');

    const { sp } = makeSoftphone();
    await sp.ready;
    const blur = winAdd.mock.calls.find(([type]) => type === 'blur');
    const focus = winAdd.mock.calls.find(([type]) => type === 'focus');
    const focusin = docAdd.mock.calls.find(([type]) => type === 'focusin');
    const keydown = docAdd.mock.calls.find(([type]) => type === 'keydown');
    const focusout = docAdd.mock.calls.find(([type]) => type === 'focusout');
    expect(blur).toBeDefined();
    expect(focus).toBeDefined();
    expect(focusin).toBeDefined();
    expect(keydown).toBeDefined();
    expect(focusout).toBeDefined();

    sp.destroy();

    expect(winRemove).toHaveBeenCalledWith('blur', blur![1]);
    expect(winRemove).toHaveBeenCalledWith('focus', focus![1]);
    expect(docRemove).toHaveBeenCalledWith('focusin', focusin![1], true);
    expect(docRemove).toHaveBeenCalledWith('keydown', keydown![1], true);
    expect(docRemove).toHaveBeenCalledWith('focusout', focusout![1], true);

    winAdd.mockRestore();
    winRemove.mockRestore();
    docAdd.mockRestore();
    docRemove.mockRestore();
  });
});
