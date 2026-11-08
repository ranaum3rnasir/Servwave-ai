/**
 * Makes jsdom look like a given device to the phone-device check
 * (lib/device/isPhoneDevice.ts): what the primary pointer is, and the
 * device's screen size in CSS px.
 *
 * It drives the two real browser inputs the check reads - `matchMedia('(pointer:
 * coarse)')` and `window.screen` - rather than mocking the check itself, so a
 * suite that uses it exercises the real rule end to end.
 *
 * When a shape gives a `viewportWidth` (the browser WINDOW, not the screen),
 * `window.innerWidth` is set to it and `(max-width: Npx)` / `(min-width: Npx)`
 * queries are answered against it, so a regression to a window-width test
 * (e.g. useIsMobile's `(max-width: 767.98px)`) really sees the narrow window.
 * Every other media query keeps the shared setup's answer (`matches: false`).
 */
import { vi } from 'vitest';

export interface DeviceShape {
  /** True when the primary pointer is a finger (`pointer: coarse`). */
  coarsePointer: boolean;
  screenWidth: number;
  screenHeight: number;
  /** The browser window's width in CSS px. Omitted = width queries answer false. */
  viewportWidth?: number;
}

/** A phone held upright: touch, 390x844. */
export const PHONE_PORTRAIT: DeviceShape = { coarsePointer: true, screenWidth: 390, screenHeight: 844 };
/** The same phone turned sideways: wider than the 767px layout breakpoint. */
export const PHONE_LANDSCAPE: DeviceShape = { coarsePointer: true, screenWidth: 932, screenHeight: 430 };
/** A full-size tablet (e.g. an 820x1180 iPad): touch, but its shortest side is 768px or more. */
export const TABLET: DeviceShape = { coarsePointer: true, screenWidth: 820, screenHeight: 1180 };
/** A full-size tablet in split view: a touch screen, but the browser window only 400px wide. */
export const TABLET_SPLIT_VIEW: DeviceShape = { ...TABLET, viewportWidth: 400 };
/** An iPad mini: touch, shortest side 744px - under the 768px line, so treated as a phone. */
export const IPAD_MINI: DeviceShape = { coarsePointer: true, screenWidth: 744, screenHeight: 1133 };
/** A computer with a mouse. */
export const DESKTOP: DeviceShape = { coarsePointer: false, screenWidth: 1920, screenHeight: 1080 };
/** A computer whose browser window is phone-width (500px); the screen itself is still a monitor. */
export const NARROW_DESKTOP_WINDOW: DeviceShape = { ...DESKTOP, viewportWidth: 500 };
/** A small laptop with a touch screen and a trackpad: the trackpad is the primary pointer. */
export const SMALL_TOUCH_LAPTOP: DeviceShape = { coarsePointer: false, screenWidth: 1280, screenHeight: 720 };

/** Applies a device shape; returns a function that restores the previous one. */
export function emulateDevice(shape: DeviceShape): () => void {
  const previousMatchMedia = window.matchMedia;
  const previousScreen = Object.getOwnPropertyDescriptor(window, 'screen');
  const previousInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');

  const answer = (query: string): boolean => {
    const q = query.replace(/\s+/g, '');
    if (q === '(pointer:coarse)') return shape.coarsePointer;
    const vw = shape.viewportWidth;
    const widths = [...q.matchAll(/\((max|min)-width:([\d.]+)px\)/g)];
    if (vw === undefined || widths.length === 0) return false;
    return widths.every(([, kind, px]) => (kind === 'max' ? vw <= Number(px) : vw >= Number(px)));
  };

  window.matchMedia = vi.fn((query: string) => ({
    matches: answer(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  Object.defineProperty(window, 'screen', {
    configurable: true,
    value: { ...window.screen, width: shape.screenWidth, height: shape.screenHeight },
  });
  if (shape.viewportWidth !== undefined) {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: shape.viewportWidth,
    });
  }

  return () => {
    window.matchMedia = previousMatchMedia;
    if (previousScreen) Object.defineProperty(window, 'screen', previousScreen);
    else delete (window as { screen?: Screen }).screen;
    if (previousInnerWidth) Object.defineProperty(window, 'innerWidth', previousInnerWidth);
  };
}
