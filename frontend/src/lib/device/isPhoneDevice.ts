/**
 * Is this browser running on a phone?
 *
 * Used to keep the in-browser phone (the WebRTC device) off phones: there every
 * call goes out as the bridge instead (the phone service rings the user's own
 * cell first, then the customer). Ran, 2026-10-02: a browser-phone call from an
 * iPhone connected with no audio either way; mobile browsers also cut call
 * audio on screen lock, app switch and an incoming cell call; and the phone
 * vendor supports its browser phone on desktop Chrome/Firefox only.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A phone = the PRIMARY pointer is coarse (a finger) AND the device's shortest
 * screen side is under 768 CSS px.
 *
 * - The screen, not the window. `window.screen` is the device's size, so a
 *   narrow browser window on a computer is still a computer (it keeps the
 *   browser phone). That is why the width-only useIsMobile() layout hook
 *   (max-width 767.98px of the VIEWPORT) must not be this test.
 * - The SHORTEST side, so rotation does not change the answer: a phone held
 *   sideways is wider than 767px (e.g. 932x430) and is still a phone.
 * - The primary pointer, so a touch-screen laptop whose primary pointer is its
 *   trackpad stays a computer, and a phone always reads coarse.
 * - Small tablets are treated as phones and get the bridge: the iPad mini
 *   (shortest side 744 CSS px) and 7-8" Android tablets fall under the line.
 *   That is deliberate: the iPad runs the same browser engine as the iPhone,
 *   where browser-phone calls had no audio, so the bridge is the safer result.
 *   Full-size tablets (shortest side 768 or more, e.g. a 820x1180 iPad) keep
 *   today's behaviour. 768 is the same line as the app's `md` breakpoint.
 * - Known false positive: a 2-in-1 in tablet mode at high display scaling (e.g.
 *   1280x720 CSS px, keyboard detached, so the primary pointer reads coarse) can
 *   be classed as a phone and get the bridge. That failure is safe: the bridge
 *   works and the call is recorded.
 * - An installed app (standalone display mode) is not a signal on its own: an
 *   app installed on a computer keeps the browser phone, and one installed on a
 *   phone is already caught by the rule.
 * - `navigator.userAgentData.mobile` is deliberately NOT used. It exists only in
 *   Chromium browsers, so it adds nothing on iOS (where the failure was seen),
 *   and as an extra "yes" it would split the tablet line per browser (some
 *   foldables and tablets report mobile=true in one browser and not in another).
 *
 * Anything it cannot read - no window (SSR), no matchMedia, a screen size of 0 -
 * answers "not a phone", which keeps today's behaviour.
 *
 * Not cached here: it is a cheap synchronous check. Rotation swaps width and
 * height, so the shortest side stays put. The phone hook (useCtmSoftphone)
 * reads it once per mount, so a mid-session change (devtools device emulation)
 * cannot drop the controls of a booted device.
 */
export const PHONE_MAX_SHORT_SIDE_PX = 768;

export function isPhoneDevice(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  const screen = window.screen;
  if (!screen) return false;
  const shortestSide = Math.min(screen.width, screen.height);
  if (!(shortestSide > 0)) return false;
  return window.matchMedia('(pointer: coarse)').matches && shortestSide < PHONE_MAX_SHORT_SIDE_PX;
}
