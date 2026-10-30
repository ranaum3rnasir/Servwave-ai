import { SWITCH_CATALOG, type SwitchEntry } from './catalog';

/**
 * Which switch emits which grant. Every grant a route checks is emitted by exactly one switch (or is fixed, or is the
 * Admin box's alone, see `../fixedGrants.ts`), so a screen can name the one switch that stands for a check and no
 * two switches can disagree about it.
 */
export const grantKey = (g: { action: string; subject: string }): string => `${g.action}:${g.subject}`;

/** Switch keys per grant, over the given catalog (the real one by default). */
export function grantOwners(catalog: readonly SwitchEntry[] = SWITCH_CATALOG): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const s of catalog) {
    for (const g of s.grants) {
      const key = grantKey(g);
      const list = owners.get(key) ?? [];
      if (!list.includes(s.key)) list.push(s.key);
      owners.set(key, list);
    }
  }
  return owners;
}

/** Grants that more than one switch emits, with their emitters. */
export function sharedGrants(catalog: readonly SwitchEntry[] = SWITCH_CATALOG): Array<{ grant: string; switches: string[] }> {
  return [...grantOwners(catalog)]
    .filter(([, switches]) => switches.length > 1)
    .map(([grant, switches]) => ({ grant, switches }));
}
