// Org branding defaults.
//
// An organization's `brand_color` is optional. Everything that renders org
// branding (the Branding settings screen, the public estimate header) falls
// back to the ServWave brand colour, which is the same colour as the
// `--primary` design token. This module is the single place that value is
// written down.

import { token } from '@/design-system/tokens';

/**
 * Default value for `organizations.brand_color`, as a 6-digit hex string.
 *
 * This is a literal hex on purpose, and it is the ONLY literal of this colour
 * outside the token layer. `token('--primary')` resolves to the same colour but
 * returns an `rgb(...)` string, which does not satisfy the contracts this
 * constant has to meet:
 *   - `<input type="color">` accepts `#rrggbb` and nothing else;
 *   - the API stores and validates `brand_color` as `/^#[0-9A-Fa-f]{6}$/`, so a
 *     non-hex default would make an untouched form read as dirty and would be
 *     rejected on save;
 *   - the "6-digit hex, e.g. ..." help text has to show the user a hex.
 *
 * Keep in sync with `--ocean-800` / `--primary` in
 * `src/design-system/tokens.css`.
 */
export const DEFAULT_BRAND_COLOR = '#0C2D3A';

/**
 * The same default, resolved live from the token layer as a CSS colour string.
 *
 * Use this wherever the value is only ever handed to CSS (a `style` background,
 * a canvas fill) and is never fed to a hex input, compared against a stored
 * hex, or shown to the user as text. Returns `rgb(12 45 58)` in the browser and
 * falls back to the hex under jsdom/SSR - both paint identically.
 */
export const defaultBrandColor = (): string => token('--primary');
