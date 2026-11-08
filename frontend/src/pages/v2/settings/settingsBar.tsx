import { createContext, useContext } from 'react';

// The saver CONTRACT is imported, never restated: every settings page - legacy
// and v2 - registers the same three-part object, and a second declaration here
// would let the two drift without the compiler noticing.
import type { SettingsSaver } from '@/lib/settings/types';

export type { SettingsSaver };

interface SettingsCtx {
  registerSaver: (fns: SettingsSaver) => void;
}

/**
 * The v2 settings save-bar registry.
 *
 * This is layout plumbing, not business logic: the shell needs a way for the
 * child route to hand it a save/discard/isDirty triple, and React context is
 * scoped to the provider instance. The legacy `SettingsLayout` keeps its own
 * private context and its own provider, so a v2 page reading the legacy
 * `useSettingsBar` would read a context no v2 layout ever provides - it would
 * silently get the default no-op and the Save bar would go dead.
 *
 * What each page DOES on save (the mutation, the payload shape, the dirty
 * derivation, the ValidationError contract) is unchanged and lives in the page,
 * exactly as it does today.
 */
const Ctx = createContext<SettingsCtx>({ registerSaver: () => {} });

export const SettingsBarProvider = Ctx.Provider;

export const useSettingsBar = () => useContext(Ctx);
