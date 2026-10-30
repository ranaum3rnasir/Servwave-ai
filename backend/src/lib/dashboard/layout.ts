import { findTile } from './tileCatalog';

/**
 * The shape of a person's saved dashboard layout (Roles & Permissions, PRD 9, S09.4): the ordered tile ids and, per
 * tile, whether it shows, its size and its time-range choice. The size and range words are the ones the page has
 * always stored, so a layout saved in a browser reads the same here.
 */
export const LAYOUT_SIZES = ['kpi', 'third', 'half', 'full'] as const;
export const LAYOUT_RANGES = ['today', '7d', '30d', 'month', 'all'] as const;

export interface LayoutEntry {
  id: string;
  visible: boolean;
  size?: (typeof LAYOUT_SIZES)[number];
  range?: (typeof LAYOUT_RANGES)[number];
}

/** A tile the catalog knows and the person may have right now. */
type CanHave = (tileId: string) => boolean;

/** An entry as the server sends it. `available: false` marks a stored tile the person cannot have right now. */
export interface ReadLayoutEntry extends LayoutEntry {
  available?: false;
}

/** The layout as the person is shown it: only the tiles the catalog knows and they may have right now, in their order. */
export function availableLayout(stored: readonly LayoutEntry[], canHave: CanHave): LayoutEntry[] {
  return stored.filter((e) => findTile(e.id) !== undefined && canHave(e.id));
}

/**
 * The stored layout as the page is sent it (PRD 9, "Tiles the person cannot have right now"): every tile the catalog
 * knows, in stored order, and a tile the person may not have right now stays in its place with its stored state,
 * flagged `available: false`, so the page keeps it where it is when it saves. The page never draws it and never offers
 * it in the picker. A tile they have carries no flag at all.
 */
export function layoutWithLostTiles(stored: readonly LayoutEntry[], canHave: CanHave): ReadLayoutEntry[] {
  return stored
    .filter((e) => findTile(e.id) !== undefined)
    .map((e) => (canHave(e.id) ? e : { ...e, available: false as const }));
}

/**
 * A saved layout merged forward with their role's default (PRD 9, "Reading"; S09.8): every tile of the default that the
 * saved layout does not hold is added at the end, shown. A tile the saved layout holds in any state (hidden, moved,
 * resized, or a lost one flagged not available) is never added, which is what makes the addition happen once: the page
 * saves the whole list, so the added tile is held from the next save on, and a removal stores a tile hidden (see
 * `mergeSavedLayout`), never drops it. The default is cut to the tiles the person may have before it comes here, so a
 * tile they cannot have is not added and is not remembered as given: it arrives when the access does. Reading never
 * writes; the merged answer is stored by the next save.
 */
export function withNewDefaultTiles(saved: readonly ReadLayoutEntry[], roleDefault: readonly LayoutEntry[]): ReadLayoutEntry[] {
  const held = new Set(saved.map((e) => e.id));
  return [...saved, ...roleDefault.filter((e) => !held.has(e.id))];
}

/** A save that would turn a tile the person cannot have from hidden, or not stored, into shown. */
export class UnavailableTileError extends Error {
  constructor(readonly tileIds: string[]) {
    super(`A save may not show a tile the person cannot have: ${tileIds.join(', ')}`);
    this.name = 'UnavailableTileError';
  }
}

/**
 * The layout to store when a person saves the one they were shown (PRD 9, "Saving"). What they sent is kept in the
 * order they sent it, minus an id the catalog does not know and a repeat. A tile they may not have RIGHT NOW (their
 * switches changed) keeps its stored state and place whatever they sent for it: it is put back right after the tile it
 * followed, so it returns in its old place if the access does, and one they left out is put back the same way.
 * The one refusal is `UnavailableTileError`: a tile they cannot have, stored hidden or not stored, sent as shown (they
 * cannot turn one on by sending it). One not stored and sent hidden is simply dropped. An id the catalog has since
 * retired is forgotten. A stored tile they CAN have that the client left out is a removal, and a removal is stored as a
 * hidden tile in its place, never forgotten (S09.8): a layout that forgot it would be given the tile again as a new
 * default tile on the next read.
 */
export function mergeSavedLayout(stored: readonly LayoutEntry[] | null, sent: readonly LayoutEntry[], canHave: CanHave): LayoutEntry[] {
  const storedById = new Map((stored ?? []).map((e) => [e.id, e]));
  const result: LayoutEntry[] = [];
  const seen = new Set<string>();
  const refused: string[] = [];
  for (const entry of sent) {
    if (seen.has(entry.id) || findTile(entry.id) === undefined) continue;
    seen.add(entry.id);
    if (canHave(entry.id)) {
      result.push(entry);
    } else if (entry.visible && storedById.get(entry.id)?.visible !== true) {
      refused.push(entry.id);
    }
  }
  if (refused.length > 0) throw new UnavailableTileError(refused);
  let followed: string | null = null;
  for (const entry of stored ?? []) {
    if (findTile(entry.id) === undefined) continue;
    const has = canHave(entry.id);
    if (has && seen.has(entry.id)) {
      followed = entry.id;
      continue;
    }
    // A tile the person lost, or one they can have that the client left out (a removal): either way it stays stored, in
    // its place. A removed tile is stored hidden, so a tile the default added later is never added to them twice.
    const after = followed === null ? -1 : result.findIndex((e) => e.id === followed);
    result.splice(followed === null ? 0 : after >= 0 ? after + 1 : result.length, 0, has ? { ...entry, visible: false } : entry);
    followed = entry.id;
  }
  return result;
}
