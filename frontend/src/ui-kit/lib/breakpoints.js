/**
 * The ONE breakpoint source.
 *
 * Two consumers read these numbers, and they must never disagree:
 *
 *   - `tailwind.config.js` sets `theme.screens` from `tailwindScreens`, so every `sm:` / `md:` /
 *     `lg:` utility in the app breaks here;
 *   - `useMediaQuery` / `useIsBelow` (ui-kit/hooks) build their queries from `MEDIA`, so whatever
 *     JavaScript decides to MOUNT (a drawer, a bottom sheet, an overflow menu) switches at the
 *     same width the CSS does.
 *
 * Before this module the shell's drawer switched below 761 px and the mobile hook below 768 px,
 * which left a band where the CSS drew one shell and the JavaScript rendered another.
 *
 * The values are Tailwind's stock screens, unchanged, so moving the config onto this module
 * changes no utility. `belowX` queries stop 0.02 px short of the next screen, the same trick
 * Tailwind's own `max-*` variants use, so a fractional width (a zoomed page) is never in both.
 *
 * Plain JavaScript, not TypeScript: Tailwind loads its config with plain Node first, and this file
 * is imported from there. `breakpoints.d.ts` beside it types it for the app.
 *
 * Width decides LAYOUT only. Interaction (target size, hover, drag activation) follows the primary
 * pointer, and nothing here, or anywhere, branches on the user agent.
 */

/** Tailwind's stock screens, in px. */
export const SCREENS = Object.freeze({ sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 });

/**
 * The one named short-height condition: a phone held sideways (838x390, 863x360). Its width is
 * desktop-class but its height is not, so chrome compacts under it.
 */
export const SHORT_HEIGHT_MAX = 500;

/** `theme.screens` for tailwind.config.js. */
export const tailwindScreens = Object.freeze(
  Object.fromEntries(Object.entries(SCREENS).map(([name, px]) => [name, `${px}px`])),
);

/** `(max-width: 767.98px)` for 768: written out so the string is exact, never a float artefact. */
const below = (px) => `(max-width: ${px - 1}.98px)`;
const atLeast = (px) => `(min-width: ${px}px)`;

/** The named media queries. Use these strings verbatim in CSS `@media` rules too. */
export const MEDIA = Object.freeze({
  /** Phone portrait. */
  belowSm: below(SCREENS.sm),
  /** Phone layout: the top-bar overflow menu, the navigation drawer, sheets instead of popovers. */
  belowMd: below(SCREENS.md),
  belowLg: below(SCREENS.lg),
  belowXl: below(SCREENS.xl),
  sm: atLeast(SCREENS.sm),
  md: atLeast(SCREENS.md),
  lg: atLeast(SCREENS.lg),
  xl: atLeast(SCREENS.xl),
  /** Landscape phone: compact chrome. */
  shortHeight: `(max-height: ${SHORT_HEIGHT_MAX}px)`,
});
