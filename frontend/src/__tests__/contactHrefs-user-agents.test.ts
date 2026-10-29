import { afterEach, describe, expect, it } from 'vitest';
import { isIosDevice, mapsHref } from '@/components/contact/contactHrefs';

/**
 * Mobile slice 73 (real-device row RD-21, TEST-07 / CMP-09): the user-agent families a headless
 * browser does not reproduce by default. iPadOS Safari presents itself as a Mac ("Macintosh"
 * agent, platform "MacIntel") and is told apart from a real Mac only by its touch points. Chrome on
 * iOS is WebKit under a "CriOS" agent that still says iPhone. Both must be Apple touch devices, so
 * an address goes to Apple Maps; a real Mac and an Android phone must not.
 */

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};

const original = {
  userAgent: Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent'),
  platform: Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform'),
};

/** jsdom has no maxTouchPoints, so each field is defined on the instance and removed afterwards. */
function device(userAgent: string, platform: string, maxTouchPoints: number) {
  for (const [key, value] of Object.entries({ userAgent, platform, maxTouchPoints })) {
    Object.defineProperty(navigator, key, { configurable: true, get: () => value });
  }
}

afterEach(() => {
  for (const key of ['userAgent', 'platform', 'maxTouchPoints']) delete (navigator as unknown as Record<string, unknown>)[key];
  expect(Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')).toEqual(original.userAgent);
  expect(Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform')).toEqual(original.platform);
});

describe('isIosDevice across the user-agent families', () => {
  it('knows an iPhone in Safari', () => {
    device(UA.iphoneSafari, 'iPhone', 5);
    expect(isIosDevice()).toBe(true);
  });
  it('knows Chrome on iOS (WebKit under a CriOS agent)', () => {
    device(UA.iphoneChrome, 'iPhone', 5);
    expect(isIosDevice()).toBe(true);
  });
  it('knows an iPad whose Safari reports a Mac (desktop agent, MacIntel, touch points)', () => {
    device(UA.ipadDesktopMode, 'MacIntel', 5);
    expect(isIosDevice()).toBe(true);
  });
  it('does not take a real Mac (no touch points) for an iPad', () => {
    device(UA.macSafari, 'MacIntel', 0);
    expect(isIosDevice()).toBe(false);
  });
  it('does not take an Android phone for an Apple device', () => {
    device(UA.androidChrome, 'Linux armv81', 5);
    expect(isIosDevice()).toBe(false);
  });
});

describe('mapsHref', () => {
  it('hands an Apple touch device the Apple Maps link, everything else the universal link', () => {
    device(UA.ipadDesktopMode, 'MacIntel', 5);
    expect(mapsHref('1 Main St', { ios: isIosDevice() })).toBe('https://maps.apple.com/?q=1%20Main%20St');
    device(UA.androidChrome, 'Linux armv81', 5);
    expect(mapsHref('1 Main St', { ios: isIosDevice() })).toBe('https://www.google.com/maps/search/?api=1&query=1%20Main%20St');
  });
});
