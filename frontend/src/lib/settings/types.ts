/**
 * The settings save contract.
 *
 * A settings page registers these with whichever settings shell renders it, and
 * the shell's save bar drives them. Declared here rather than in a shell so the
 * legacy `SettingsLayout` and the /v2 settings bar cannot drift apart on what a
 * saver is.
 */
export interface SettingsSaver {
  save: () => Promise<void> | void;
  discard: () => void;
  /**
   * Are there edits to lose? This is NOT just the Save button: the shell also
   * pushes it into the settings guard store, which arms the unsaved-changes
   * confirm for the topbar user menu, the sidebar, GlobalSearch, browser
   * reload/tab-close, the popstate handler and the settings sub-nav links. So it
   * must answer only that question - a page that ANDs a validity flag into it
   * disarms all of the above and lets the user walk away from real edits with no
   * prompt.
   */
  isDirty: boolean;
  /**
   * Can those edits be written RIGHT NOW? Optional, and omitting it means yes -
   * every page that has no client-side rule of its own registers exactly what it
   * registers today and behaves exactly as it does today.
   *
   * A page sets it to `false` while it holds an edit it is going to refuse (My
   * Profile with an unusable phone number), which greys the Save button without
   * touching `isDirty`, so the leave guard stays armed and Discard stays
   * available. The page must STILL refuse the write in `save` - the two are
   * separate concerns, and only the throw explains itself to the user.
   */
  canSave?: boolean;
}

/**
 * Should the shell's Save button be live?
 *
 * Both shells derive it through this one function, for the same reason the
 * interface lives here: two copies of `isDirty && canSave !== false` is two
 * chances to disagree. Callers add their own `saving` term.
 */
export function canSubmitSaver(saver: SettingsSaver): boolean {
  return saver.isDirty && saver.canSave !== false;
}
