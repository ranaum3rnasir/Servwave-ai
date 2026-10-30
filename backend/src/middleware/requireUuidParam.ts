import { Request, Response, NextFunction } from 'express';
import { isCanonicalId, markCanonicalIdGuard } from '../lib/ids/canonicalId';

/**
 * Guard a route `:param` that must be a UUID.
 *
 * A malformed path id (a client-side placeholder like `po_new_…`, a truncated
 * deep-link, a hand-typed URL) otherwise reaches Prisma's `where: { id }` — but
 * these columns are Postgres `uuid`, so the driver throws P2023 and the
 * controller's catch turns it into a 500. This fails fast with the SAME 404 the
 * handler returns for a genuinely-absent row, before Prisma is ever touched — a
 * malformed id and a missing row are indistinguishable to the client by design
 * (neither can name a real resource).
 *
 * Mirrors the inline `z.string().uuid().safeParse(id)` guard already used for
 * `DELETE /vendors/:id` (inv-vendors.controller.ts) — centralised so `:id`
 * routes can share it rather than re-implementing the check per handler.
 *
 * Only the canonical spelling passes (lower case, with the dashes; lib/ids/canonicalId.ts): the database would read an upper
 * case, dash-less, braced or `urn:uuid:` spelling as the same record, and a check further on may only know the canonical one.
 */
export function requireUuidParam(param: string, notFoundMessage = 'Not found') {
  return markCanonicalIdGuard([param], (req: Request, res: Response, next: NextFunction): void => {
    if (!isCanonicalId(req.params[param])) {
      res.status(404).json({ error: notFoundMessage });
      return;
    }
    next();
  });
}

