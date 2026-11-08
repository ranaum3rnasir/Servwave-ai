import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import { writeSettingsAudit, logAudit } from '../lib/audit';

const param = (req: Request, name: string): string => req.params[name] as string;

export const createLocationSchema = z
  .object({
    // Trimmed BEFORE `.min(1)`, in that order: `.min(1)` alone accepts ' ', and every one of this
    // row's address fields is optional, so a location could be created carrying no legible text at
    // all. The name is the only field guaranteed to be there, which makes it the field a visit
    // booked here renders from - "Please meet us at  ." in a customer's inbox (visit-location spec
    // D7). `validate` assigns the parse result back onto `req.body`, so the trimmed value is what
    // gets stored. `.partial()` carries this into updateLocationSchema below, which is why Edit
    // cannot blank a name that Create refused.
    name: z.string().trim().min(1).max(120),
    code: z.string().max(20).nullable().optional(),
    address_line1: z.string().max(200).optional(),
    address_line2: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(50).optional(),
    postal_code: z.string().max(20).optional(),
    country: z.string().length(2).optional(),
    timezone: z.string().max(64).optional(),
    phone: z.string().max(50).optional(),
    manager_id: z.string().uuid().nullable().optional(),
  })
  .strict();

// #107 (C2) — Edit loads the raw API row, which carries server-echoed read-only
// keys (id/created_at/updated_at/manager/_count) and `null` optionals. Strip
// unknown keys (instead of strict-400) and accept `null` for the optional string
// fields so a full-row PATCH round-trips. `manager_id` is already nullable.
export const updateLocationSchema = createLocationSchema
  .partial()
  .extend({
    address_line1: z.string().max(200).nullable().optional(),
    address_line2: z.string().max(200).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    state: z.string().max(50).nullable().optional(),
    postal_code: z.string().max(20).nullable().optional(),
    country: z.string().length(2).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
  })
  .strip();

export const listLocations = async (req: Request, res: Response) => {
  try {
    const locations = await prisma.location.findMany({
      where: { ...tenantWhere(req) },
      orderBy: { name: 'asc' },
      include: {
        manager: { select: { id: true, first_name: true, last_name: true } },
        _count: { select: { members: true } },
      },
    });
    res.json(locations);
  } catch (err) {
    logger.error('listLocations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createLocation = async (req: Request, res: Response) => {
  try {
    const data = req.body as z.infer<typeof createLocationSchema>;
    const created = await prisma.location.create({ data: { ...data, ...tenantWhere(req) } });
    await writeSettingsAudit(req, 'location.created', { location_id: created.id, name: created.name });
    void logAudit({ req, action: 'location.created', resourceType: 'Location', resourceId: created.id });
    res.status(201).json(created);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'A location with that code already exists' });
      return;
    }
    logger.error('createLocation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateLocation = async (req: Request, res: Response) => {
  try {
    const data = req.body as z.infer<typeof updateLocationSchema>;
    const result = await prisma.location.updateMany({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      data,
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }
    const location = await prisma.location.findFirst({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    await writeSettingsAudit(req, 'location.updated', { location_id: param(req, 'id') });
    void logAudit({ req, action: 'location.updated', resourceType: 'Location', resourceId: param(req, 'id') });
    res.json(location);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'A location with that code already exists' });
      return;
    }
    logger.error('updateLocation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** `2 users` / `1 user` - the count and its noun, so the message reads as a sentence either way. */
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * DELETE survives archiving, deliberately (visit-location spec D9).
 *
 * A location nothing references - created by mistake, never used - is still removable outright.
 * Forcing an admin to archive a typo would be worse than the problem archiving solves, and would
 * leave a permanent row in a list nobody can tidy.
 *
 * What changed in slice 2 is the REFUSAL, in two ways.
 *
 * It reports in ONE ROUND. It used to answer with the first blocker it found, so a location with
 * both users assigned and visits booked named only the users: the admin reassigned four people,
 * retried, and only then learned about the visits - which, unlike the users, they cannot clear at
 * all. Both counts are taken before the message is composed, so one refusal names everything
 * standing in the way.
 *
 * And it NAMES THE WAY OUT. Refusing without one is a dead end that leaves closing a branch with
 * no legitimate move, which is exactly the pressure that makes people delete data they should
 * have kept. Archiving takes the location out of every booking picker while every visit already
 * booked there goes on resolving.
 */
export const deleteLocation = async (req: Request, res: Response) => {
  try {
    // Both counts, always, and independent of each other - see the one-round rule above. `visits`
    // is here because `visits.location_id` is ON DELETE RESTRICT on purpose: nulling the reference
    // would silently move a booked visit back to the customer's own address after the customer has
    // been told to come here. Unguarded, that restriction reaches this handler as a P2003 and the
    // catch below turns it into an opaque 500 on a perfectly reasonable admin action.
    //
    // Every visit, not just the live ones: a completed trip still points at this row, so the
    // database would refuse the delete no matter how the count was narrowed.
    const [assignedUsers, visitsHere] = await Promise.all([
      prisma.user.count({ where: { location_id: param(req, 'id'), ...tenantWhere(req) } }),
      prisma.visit.count({ where: { location_id: param(req, 'id'), ...tenantWhere(req) } }),
    ]);
    if (assignedUsers > 0 || visitsHere > 0) {
      const blocking = [
        assignedUsers > 0 ? `${plural(assignedUsers, 'user')} assigned to it` : null,
        visitsHere > 0 ? `${plural(visitsHere, 'visit')} booked at it` : null,
      ].filter(Boolean);
      res.status(409).json({
        error:
          `Cannot delete: this location has ${blocking.join(' and ')}. ` +
          'Archive it instead - it stops appearing when anyone books, and everything already ' +
          'pointing at it keeps reading correctly.',
      });
      return;
    }
    const result = await prisma.location.deleteMany({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (result.count === 0) {
      res.status(404).json({ error: 'Location not found' });
      return;
    }
    await writeSettingsAudit(req, 'location.deleted', { location_id: param(req, 'id') });
    void logAudit({ req, action: 'location.deleted', resourceType: 'Location', resourceId: param(req, 'id') });
    res.status(204).send();
  } catch (err) {
    logger.error('deleteLocation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Archive and unarchive - the escape a referenced location needs (visit-location spec D9, slice 2).
 *
 * ONE implementation for both, because they are the same write in opposite directions and a
 * second copy is how the undo would one day forget to clear `archived_at`. The row is only ever
 * UPDATED: archiving that deleted anything would take the address off every visit already booked
 * here, which is the exact failure the restricting foreign key exists to prevent.
 *
 * Scoped with `updateMany` + `tenantWhere`, exactly as `updateLocation` is, so a location in
 * another organisation answers 404 rather than being archived by id alone.
 *
 * Gated on `update Location` (see location.routes.ts), the grant that already lets somebody edit
 * this row, rather than on a new catalog action: a new grantable capability has to be backfilled
 * into every organisation's `role_permissions` before anyone can use it, and an admin who may
 * rename a branch may reasonably close one.
 *
 * EITHER DIRECTION IS A NO-OP THE SECOND TIME, and the current state is part of the WHERE clause
 * rather than a read taken before the write. `archived_at` answers exactly one question - when
 * did this branch close - so a repeat archive that re-stamps it destroys the only thing the
 * column is for, and a second pair of audit rows minutes later records a state change that never
 * happened. The screen never offers it (the row carries one button and it flips), but a tab left
 * open before somebody else archived, and any script, both reach the route. Folding the state
 * into the match keeps this ONE statement: a read-then-write would be a snapshot rather than a
 * lock, so two archives arriving together would both see an active row and both write. A no-op
 * matches zero rows and falls through to the same 404 a location in another organisation gets,
 * which is both honest - there is no location here in the state this door acts on - and
 * deliberately indistinguishable, so the door stays free of an oracle.
 *
 * The route pair is `archive` / `unarchive`, matching `POST /api/customers/:id/unarchive` - this
 * repo's only other archive-and-undo pair, down to `unarchiveCustomer` and its `Customer
 * unarchived` audit description. With exactly one precedent, matching it beats coining a second
 * vocabulary for the same act. The BUTTON still reads "Restore", which is the spec's word and the
 * better one above a table row; UI copy and API vocabulary already diverge here on purpose (the
 * product says "walkthrough" where the routes say `visits`), and that costs nothing so long as
 * the API keeps ONE verb underneath whatever label reads best.
 */
const setArchived = (archived: boolean, action: 'location.archived' | 'location.unarchived') =>
  async (req: Request, res: Response) => {
    try {
      const id = param(req, 'id');
      const result = await prisma.location.updateMany({
        // `is_active: archived` is the state the row must ALREADY be in, not the one being
        // written: archiving matches a location that is still active, unarchiving one that is
        // not. See the no-op paragraph above - a repeat of either matches nothing, so nothing is
        // re-stamped and nothing is audited.
        where: { id, ...tenantWhere(req), is_active: archived },
        // `archived_at` is cleared on the way back rather than left standing: it means "when this
        // location stopped being bookable", and one that is bookable again has no such moment.
        data: archived ? { is_active: false, archived_at: new Date() } : { is_active: true, archived_at: null },
      });
      if (result.count === 0) {
        res.status(404).json({ error: 'Location not found' });
        return;
      }
      const location = await prisma.location.findFirst({ where: { id, ...tenantWhere(req) } });
      // Audited the way `location.deleted` is - both trails, because they answer different
      // questions: the settings timeline is what an admin reads, the audit log is the org-wide
      // security record.
      await writeSettingsAudit(req, action, { location_id: id });
      void logAudit({ req, action, resourceType: 'Location', resourceId: id });
      res.json(location);
    } catch (err) {
      logger.error(`${action} error:`, err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

export const archiveLocation = setArchived(true, 'location.archived');
export const unarchiveLocation = setArchived(false, 'location.unarchived');
