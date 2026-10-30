import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { presetRoleOfPerson, resolveSwitches, type SwitchSubject } from '../../lib/permissions/switches/store';
import { defaultLayoutOf, eligibleTiles, findTile, TILE_CATALOG, type SwitchValues } from '../../lib/dashboard/tileCatalog';
import {
  availableLayout, LAYOUT_RANGES, LAYOUT_SIZES, layoutWithLostTiles, mergeSavedLayout, withNewDefaultTiles, type LayoutEntry, type ReadLayoutEntry,
} from '../../lib/dashboard/layout';

/**
 * A person's saved dashboard layout (Roles & Permissions, PRD 9, M10). Every call acts on the signed-in person: the
 * person is the one argument, taken from the request's own session, never from anything the client sends.
 */

/** A layout holds each tile at most once, so this is room for every tile with plenty to spare, and no more. */
const MAX_ENTRIES = TILE_CATALOG.length * 4;

const layoutEntrySchema = z.object({
  id: z.string().min(1).max(100),
  visible: z.boolean(),
  size: z.enum(LAYOUT_SIZES).optional(),
  range: z.enum(LAYOUT_RANGES).optional(),
});
/** What a save may send: the whole layout. Other keys on an entry are dropped, not stored. */
export const saveLayoutSchema = z.object({ layout: z.array(layoutEntrySchema).max(MAX_ENTRIES) });
const storedLayoutSchema = z.array(layoutEntrySchema);

/**
 * What a browser layout carried over may hold (S09.5): the same entries as a save, but room for a browser copy that grew
 * stale ids over the years, since ids the catalog does not know are dropped here, not refused. Only a list so long it
 * cannot be a layout is turned away.
 */
const CARRY_OVER_MAX_ENTRIES = 500;
export const carryOverLayoutSchema = z.object({ layout: z.array(layoutEntrySchema).max(CARRY_OVER_MAX_ENTRIES) });

export interface MyLayout {
  /**
   * The saved layout merged forward with the role's default (a default tile it lacks is added at the end, shown, once;
   * S09.8), or the role's default when nothing is saved. A saved tile the person cannot have right now stays
   * in its place flagged `available: false` (the page never draws it or offers it, and sends it back on a save); the
   * role's default holds only tiles the person has.
   */
  layout: ReadLayoutEntry[];
  /**
   * Whether a layout is saved for the person at all: a row exists, even an empty one or one this build cannot read.
   * `layout` alone cannot tell, because it falls back to the role's default. It follows the row, so a later reset
   * (which replaces the row, never deletes it) cannot make the browser copy count again.
   */
  saved: boolean;
}

/** The person's row, if they have one: `layout` is null when the row holds a shape this build cannot read. */
interface StoredRow {
  layout: LayoutEntry[] | null;
}

async function whatThePersonCanHave(user: SwitchSubject): Promise<(tileId: string) => boolean> {
  const ids = new Set(eligibleTiles(await resolveSwitches(user)).map((t) => t.id));
  return (tileId) => ids.has(tileId);
}

async function storedRow(userId: string): Promise<StoredRow | null> {
  const row = await prisma.userDashboardLayout.findUnique({ where: { user_id: userId }, select: { layout: true } });
  if (!row) return null;
  // A row this build cannot read (a shape it never wrote) draws as the role's default, but it is still a saved row.
  const parsed = storedLayoutSchema.safeParse(row.layout);
  return { layout: parsed.success ? parsed.data : null };
}

async function storedLayout(userId: string): Promise<LayoutEntry[] | null> {
  return (await storedRow(userId))?.layout ?? null;
}

/** The default of the role the person is based on, cut to the tiles the person may have. */
async function roleDefaultLayout(user: SwitchSubject, canHave: (tileId: string) => boolean): Promise<LayoutEntry[]> {
  return availableLayout(defaultLayoutOf(await presetRoleOfPerson(user)), canHave);
}

async function answer(user: SwitchSubject, stored: StoredRow | null, canHave: (tileId: string) => boolean): Promise<MyLayout> {
  const roleDefault = await roleDefaultLayout(user, canHave);
  const layout = stored?.layout ? withNewDefaultTiles(layoutWithLostTiles(stored.layout, canHave), roleDefault) : roleDefault;
  return { layout, saved: stored !== null };
}

/** Read my layout. A person who has saved none is given their role's default, and nothing is stored for them. */
export async function readMyLayout(user: SwitchSubject): Promise<MyLayout> {
  const [canHave, stored] = await Promise.all([whatThePersonCanHave(user), storedRow(user.id)]);
  return answer(user, stored, canHave);
}

/**
 * The ids of the tiles the person's home page draws, in order: shown in their layout (saved, or their role's default
 * when nothing is saved) and still theirs to have. The dashboard read computes these and no others. One read of the
 * layout row; the person's switches are handed in, already resolved by the caller.
 */
export async function shownTileIds(user: SwitchSubject, values: SwitchValues): Promise<string[]> {
  const eligible = new Set(eligibleTiles(values).map((t) => t.id));
  const mine = await answer(user, await storedRow(user.id), (tileId) => eligible.has(tileId));
  return mine.layout.filter((entry) => entry.visible && entry.available !== false).map((entry) => entry.id);
}

/**
 * Save my layout: the whole layout the person was shown. A tile they cannot have right now keeps its stored state and
 * place (see `mergeSavedLayout`), so reordering or hiding the others always saves. The one refusal is
 * `UnavailableTileError`: a save that would show a tile they cannot have.
 */
export async function saveMyLayout(user: SwitchSubject, sent: LayoutEntry[]): Promise<MyLayout> {
  const [canHave, stored] = await Promise.all([whatThePersonCanHave(user), storedLayout(user.id)]);
  const merged = mergeSavedLayout(stored, sent, canHave);
  const layout = merged as unknown as Prisma.InputJsonValue;
  await prisma.userDashboardLayout.upsert({
    where: { user_id: user.id },
    create: { user_id: user.id, organization_id: user.organization_id, layout },
    update: { layout },
  });
  return answer(user, { layout: merged }, canHave);
}

/**
 * Reset my layout (S09.6): the saved layout is replaced with the default of the role the person is based on, cut to the
 * tiles they may have now (a role made from blank resets to an empty layout). The row is replaced, never deleted: a
 * missing row would read as "nothing saved" and let a browser copy be carried over again (see `carryOverMyLayout`).
 */
export async function resetMyLayout(user: SwitchSubject): Promise<MyLayout> {
  const canHave = await whatThePersonCanHave(user);
  const roleDefault = await roleDefaultLayout(user, canHave);
  const layout = roleDefault as unknown as Prisma.InputJsonValue;
  await prisma.userDashboardLayout.upsert({
    where: { user_id: user.id },
    create: { user_id: user.id, organization_id: user.organization_id, layout },
    update: { layout },
  });
  return { layout: roleDefault, saved: true };
}

/**
 * Carry over the layout this person kept in their browser (S09.5), once. Stores it only if nothing is saved for the
 * person yet: the write is insert-or-nothing, so two tabs opening at the same moment write one row and a layout the
 * person has since saved can never be replaced by an old browser copy. A tile the catalog does not know and a repeat
 * are dropped; a tile the person may not have is stored HIDDEN (a plain save would drop it), kept where the browser had
 * it, so it stays hidden if the access returns. When nothing usable is left nothing is stored. Answers as a read does:
 * whatever is saved afterwards, which is the earlier layout when one already existed.
 */
export async function carryOverMyLayout(user: SwitchSubject, browser: LayoutEntry[]): Promise<MyLayout> {
  const canHave = await whatThePersonCanHave(user);
  const seen = new Set<string>();
  const carried: LayoutEntry[] = [];
  for (const entry of browser) {
    if (seen.has(entry.id) || findTile(entry.id) === undefined) continue;
    seen.add(entry.id);
    carried.push(canHave(entry.id) ? entry : { ...entry, visible: false });
  }
  if (carried.length > 0) {
    await prisma.userDashboardLayout.createMany({
      data: [{ user_id: user.id, organization_id: user.organization_id, layout: carried as unknown as Prisma.InputJsonValue }],
      skipDuplicates: true,
    });
  }
  return answer(user, await storedRow(user.id), canHave);
}
