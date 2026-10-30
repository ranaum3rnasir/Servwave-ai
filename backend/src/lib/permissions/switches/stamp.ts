import type { SwitchSubject } from './store';
import { readAccessStamp } from '../accessStamp';

/**
 * P17 - the version stamp of a person's switches.
 *
 * The client keeps its own copy of the switches to draw menus and buttons. Rather than refetch it on a timer, it
 * refetches when this stamp moves: the server sends it on /auth/me and on every authenticated response, so a change
 * made by an Admin reaches the person's screen on the next response they receive.
 *
 * It is a digest of everything the person's switches are read from: their own override rows, the rows of the role
 * they are based on, that role itself (its base, archive flag, edit time), which role they are based on, their
 * department (Their team reads it) and their Admin flag. A role edit therefore moves every member's stamp, a person
 * edit only that person's. The Admin box holds no stored set: its stamp is a constant, and only losing or gaining the
 * flag moves it.
 *
 * It is the `switches` half of the access stamp (lib/permissions/accessStamp.ts), read from the database each time, never
 * from a server's memory: the same stamp also decides whether a server may still use the switches it holds in memory
 * (switches/cache.ts), so every server agrees on it (ticket 37). The authentication middleware reads it once per request and
 * sets the header itself.
 */
export const SWITCHES_STAMP_HEADER = 'X-Access-Stamp';

export async function computeSwitchesStamp(user: SwitchSubject): Promise<string> {
  const stamp = await readAccessStamp(user.id);
  if (!stamp) throw new Error('no stamp for person');
  return stamp.switches;
}
