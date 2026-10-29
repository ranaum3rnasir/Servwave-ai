import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

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
 */
export function requireUuidParam(param: string, notFoundMessage = 'Not found') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!z.string().uuid().safeParse(req.params[param]).success) {
      res.status(404).json({ error: notFoundMessage });
      return;
    }
    next();
  };
}
