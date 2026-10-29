// Mobile slice 63: the call transport is chosen by DEVICE, never by role. A phone and the installed
// app on a touch device call by the bridge (the phone service rings the user's own phone first) and
// open the dialer in the same tab; a computer keeps the in-browser phone for every role.
import { afterEach, describe, expect, it } from 'vitest';

import { usesBridgeTransport } from '@/lib/device/usesBridgeTransport';
import {
  DESKTOP,
  DESKTOP_INSTALLED,
  IPAD_MINI,
  NARROW_DESKTOP_WINDOW,
  PHONE_INSTALLED,
  PHONE_LANDSCAPE,
  PHONE_PORTRAIT,
  TABLET,
  TABLET_INSTALLED,
  emulateDevice,
} from '@/__tests__/support/deviceShape';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('usesBridgeTransport', () => {
  it.each([
    ['a phone held upright', PHONE_PORTRAIT],
    ['a phone turned sideways', PHONE_LANDSCAPE],
    ['a small tablet (iPad mini)', IPAD_MINI],
    ['a phone installed to the Home Screen', PHONE_INSTALLED],
  ])('%s calls by the bridge', (_name, shape) => {
    restore = emulateDevice(shape);
    expect(usesBridgeTransport()).toBe(true);
  });

  it('a full-size tablet in the installed app calls by the bridge: a Home Screen app drops new windows, so the phone tab cannot open', () => {
    restore = emulateDevice(TABLET_INSTALLED);
    expect(usesBridgeTransport()).toBe(true);
  });

  it.each([
    ['a computer with a mouse', DESKTOP],
    ['a narrow browser window on a computer', NARROW_DESKTOP_WINDOW],
    ['a full-size tablet in a browser tab', TABLET],
    ['a computer with ServWave installed as a desktop app', DESKTOP_INSTALLED],
  ])('%s keeps the in-browser phone', (_name, shape) => {
    restore = emulateDevice(shape);
    expect(usesBridgeTransport()).toBe(false);
  });

  it('a browser without matchMedia is not treated as a bridge device', () => {
    restore = emulateDevice(PHONE_PORTRAIT);
    const mm = window.matchMedia;
    // @ts-expect-error - simulating an environment without matchMedia
    window.matchMedia = undefined;
    try {
      expect(usesBridgeTransport()).toBe(false);
    } finally {
      window.matchMedia = mm;
    }
  });
});
