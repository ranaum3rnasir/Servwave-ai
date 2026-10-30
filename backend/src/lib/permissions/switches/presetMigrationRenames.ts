/**
 * Switches the applied preset migration (20261012120000) wrote under a key that a LATER migration renamed.
 *
 * The applied file is frozen, so it still writes the old key. The catalog holds the new one, and the follow-up migration
 * carries every stored row from one to the other, so the old key being gone from the catalog is not drift: the drift
 * check follows the rename and compares the presets under the new key. Add an entry here in the same change as the
 * follow-up migration that does the rename, and list ONLY renames that migration really makes.
 */
export const PRESET_FOLLOW_UP_RENAMES: ReadonlyArray<{ migration: string; renames: ReadonlyArray<{ from: string; to: string }> }> = [
  {
    // M4 part 2: See financial data became See costs, and now stands on See prices.
    migration: '20261028100400_permission_see_prices_root',
    renames: [{ from: 'see_financial_data', to: 'see_costs' }],
  },
];

/** The key the catalog holds now for a switch the applied migration wrote, when a later migration renamed it. */
export function renamedSwitchKey(from: string): string | undefined {
  for (const f of PRESET_FOLLOW_UP_RENAMES) {
    const hit = f.renames.find((r) => r.from === from);
    if (hit) return hit.to;
  }
  return undefined;
}
