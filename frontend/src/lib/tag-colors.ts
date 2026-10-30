/**
 * The tag colour palette — the single source of truth for both tag pickers.
 *
 * These are persisted values, not theme tokens: each tag row stores its own
 * `#RRGGBB` in the database, so they cannot become CSS variables. What they can
 * do is exist exactly once. TagInput (which creates tags from a record) and
 * the Settings > Lists Tags card (which recolours them in Settings) must offer the same set,
 * or an admin cannot reach a colour a user already picked.
 */
export const TAG_COLORS = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#06B6D4',
  '#3B82F6', '#8B5CF6', '#EC4899', '#6B7280', '#14B8A6',
];

/**
 * The name of each palette colour, in the SAME order as `TAG_COLORS` (Settings > Lists says "Violet", not a hex).
 * Kept as a parallel list rather than a hex-keyed map so a colour value still exists in exactly one place above.
 */
export const TAG_COLOR_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Violet', 'Pink', 'Grey', 'Teal'] as const;

/** The colour a new tag starts on: Grey. */
export const DEFAULT_TAG_COLOR: string = TAG_COLORS[TAG_COLOR_NAMES.indexOf('Grey')]!;

/** A palette colour's name for its stored value (case-insensitive); the value itself for a colour off the palette. */
export function tagColorName(hex: string): string {
  const i = TAG_COLORS.findIndex((c) => c.toUpperCase() === hex.toUpperCase());
  return i >= 0 ? TAG_COLOR_NAMES[i]! : hex;
}
