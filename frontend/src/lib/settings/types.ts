/**
 * The settings save contract.
 *
 * A settings page registers these three with whichever settings shell renders
 * it, and the shell's save bar drives them. Declared here rather than in a
 * shell so the legacy `SettingsLayout` and the /v2 settings bar cannot drift
 * apart on what a saver is.
 */
export interface SettingsSaver {
  save: () => Promise<void> | void;
  discard: () => void;
  isDirty: boolean;
}
