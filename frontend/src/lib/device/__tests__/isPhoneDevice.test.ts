// Which devices count as a phone for the phone service (Ran, 2026-10-02): on a
// phone every call goes out as the bridge, because the in-browser phone has no
// working audio on mobile browsers. A computer - however narrow its window -
// and a full-size tablet keep today's behaviour; a small tablet (iPad mini,
// 7-8" Android) is treated as a phone.
import { afterEach, describe, expect, it } from 'vitest';

import { isPhoneDevice } from '@/lib/device/isPhoneDevice';
import {
  DESKTOP,
  IPAD_MINI,
  NARROW_DESKTOP_WINDOW,
  PHONE_LANDSCAPE,
  PHONE_PORTRAIT,
  SMALL_TOUCH_LAPTOP,
  TABLET,
  TABLET_SPLIT_VIEW,
  emulateDevice,
} from '@/__tests__/support/deviceShape';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('isPhoneDevice', () => {
  it('a phone held upright is a phone', () => {
    restore = emulateDevice(PHONE_PORTRAIT);
    expect(isPhoneDevice()).toBe(true);
  });

  it('a phone turned sideways (932x430, wider than the layout breakpoint) is still a phone', () => {
    restore = emulateDevice(PHONE_LANDSCAPE);
    expect(isPhoneDevice()).toBe(true);
  });

  it('a computer with a mouse is not a phone', () => {
    restore = emulateDevice(DESKTOP);
    expect(isPhoneDevice()).toBe(false);
  });

  it('a narrow browser window on a computer is not a phone (it is the screen that counts, not the window)', () => {
    restore = emulateDevice(NARROW_DESKTOP_WINDOW); // the window itself is 500px wide
    expect(isPhoneDevice()).toBe(false);
  });

  it('a full-size tablet (touch, 820x1180 iPad) is not a phone: it keeps the browser phone', () => {
    restore = emulateDevice(TABLET);
    expect(isPhoneDevice()).toBe(false);
  });

  it('an iPad mini (touch, 744x1133) is treated as a phone: it gets the bridge', () => {
    restore = emulateDevice(IPAD_MINI);
    expect(isPhoneDevice()).toBe(true);
  });

  it('a tablet in split view (a touch screen, but the browser window only 400px wide) is still not a phone', () => {
    restore = emulateDevice(TABLET_SPLIT_VIEW);
    expect(isPhoneDevice()).toBe(false);
  });

  it('a touch device whose shortest side is just under 768px is a phone; at 768px it is a tablet', () => {
    restore = emulateDevice({ coarsePointer: true, screenWidth: 767, screenHeight: 1024 });
    expect(isPhoneDevice()).toBe(true);
    restore();
    restore = emulateDevice({ coarsePointer: true, screenWidth: 768, screenHeight: 1024 });
    expect(isPhoneDevice()).toBe(false);
  });

  it('a small touch-screen laptop whose primary pointer is the trackpad is not a phone', () => {
    restore = emulateDevice(SMALL_TOUCH_LAPTOP);
    expect(isPhoneDevice()).toBe(false);
  });

  it('a phone-sized screen with a fine primary pointer is not a phone (a mouse means a computer)', () => {
    restore = emulateDevice({ coarsePointer: false, screenWidth: 390, screenHeight: 844 });
    expect(isPhoneDevice()).toBe(false);
  });

  it('an unknown screen size (reported as 0) is not treated as a phone', () => {
    restore = emulateDevice({ coarsePointer: true, screenWidth: 0, screenHeight: 0 });
    expect(isPhoneDevice()).toBe(false);
  });

  it('a browser without matchMedia is not treated as a phone', () => {
    restore = emulateDevice(PHONE_PORTRAIT);
    const mm = window.matchMedia;
    // @ts-expect-error - simulating an environment without matchMedia
    window.matchMedia = undefined;
    try {
      expect(isPhoneDevice()).toBe(false);
    } finally {
      window.matchMedia = mm;
    }
  });
});
