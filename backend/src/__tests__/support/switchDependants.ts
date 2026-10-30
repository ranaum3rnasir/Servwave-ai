import { SWITCH_CATALOG } from '../../lib/permissions/switches/catalog';

/**
 * The given switches off, and every switch that needs one of them off with it, so the set stays storable (a chain such as
 * Create requires Edit requires View). A test that turns a root off without this is refused by the catalog's own validator.
 */
export function withDependantsOff(off: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = Object.fromEntries(off.map((k) => [k, false]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of SWITCH_CATALOG) {
      if (!(s.key in out) && s.requires.some((r) => out[r] === false)) {
        out[s.key] = false;
        grew = true;
      }
    }
  }
  return out;
}
