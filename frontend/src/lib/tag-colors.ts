/**
 * The tag colour palette — the single source of truth for both tag pickers.
 *
 * These are persisted values, not theme tokens: each tag row stores its own
 * `#RRGGBB` in the database, so they cannot become CSS variables. What they can
 * do is exist exactly once. TagInput (which creates tags from a record) and
 * TagsSettingsCard (which recolours them in Settings) must offer the same set,
 * or an admin cannot reach a colour a user already picked.
 */
export const TAG_COLORS = [
  '#EF4444', '#F97316', '#EAB308', '#22C55E', '#06B6D4',
  '#3B82F6', '#8B5CF6', '#EC4899', '#6B7280', '#14B8A6',
];
