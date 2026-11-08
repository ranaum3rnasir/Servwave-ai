import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { logger } from '../lib/logger';

/**
 * Turns multer's own aborts into honest, user-facing responses.
 *
 * WHY THIS EXISTS. Every multipart route caps `fileSize` at the multer layer. When a file
 * exceeds that cap multer aborts the stream and calls `next(err)` with a `MulterError` —
 * the route's handler never runs, so the handler's own precise size check never runs either.
 * Nothing handled `MulterError`, so it fell through to app.ts's blanket final middleware and
 * came back as `500 {"error":"Internal server error"}`. A technician uploading a large video
 * saw a toast that read like the server had crashed, when the file was simply too big.
 *
 * WHY PER-ROUTE AND NOT ONE GLOBAL HANDLER. A global handler cannot name a true limit,
 * because there is no single limit to name. Nine multipart routes share five distinct
 * multer ceilings — 2MB (org logo), 10MB (both avatar routes, estimate photo, price-book
 * image), 25MB (asset photo, email attachment), 60MB (generic attachments) and 100MB
 * (stage attachments) — and most of those ceilings sit ABOVE a tighter check the handler
 * applies afterwards, so the route's multer number is usually not the number the user is
 * subject to either. Counting the caps users are actually held to, the surfaces answer
 * 2MB, 8MB, 25MB, 50MB and 100MB. One global handler reporting a hardcoded size would be
 * wrong on nearly every route it covered: it would promise 50MB to an admin whose 3MB
 * company logo the 2MB cap had just refused. So each route supplies its own true sentence
 * through `multerErrorHandler(...)`, mounted immediately after its multer middleware.
 *
 * THE 512MB VIDEO CAP WIDENED THAT SPREAD RATHER THAN CLOSING IT. Attachment video now goes
 * direct to storage at 512MB against a 2GB per-entity total, while every route listed above
 * still buffers the file in this process and keeps the ceiling it had — including the
 * attachment proxy route, which still answers 50MB for video. The caps a user can meet
 * therefore run from 2MB to 2GB, and the argument against a single global sentence is
 * stronger than when it was written, not weaker.
 *
 * `globalMulterErrorHandler` is the safety net for any multipart route that is added later
 * and forgets to mount one. It deliberately names NO size at all: a route-accurate message
 * is better, a vague message is acceptable, and a confidently wrong number is not.
 */

/**
 * Renders a byte cap as the users see it, e.g. 8388608 -> '8MB'.
 *
 * Every route builds its message from the SAME constant its size check enforces, passed
 * through here. That is the whole point: a literal in the copy would silently become a lie
 * the day someone retunes the constant, and a message that lies about the limit is worse
 * than the 500 this middleware replaced, because the user believes it.
 *
 * SEVEN route files call it: user, organization, comm-email, inv-stages, inv-assets,
 * price-book and estimate. (The 512MB PR's description said six — it was miscounted, and
 * the number is recorded here rather than in prose because `grep -rn megabytes
 * backend/src/routes` is the only thing that can keep it honest.) `attachment.routes.ts`
 * is deliberately NOT among them: it goes through `sizeLimitLabel` instead.
 */
export function megabytes(bytes: number): string {
  return `${bytes / 1024 / 1024}MB`;
}

/**
 * The same job as `megabytes`, for a cap large enough that megabytes stop reading as a limit.
 *
 * The per-entity total is 2GB. `megabytes()` renders that as '2048MB', which is accurate and
 * which nobody reads as "two gigabytes" — a limit the user cannot hold in their head is only
 * marginally better than an unexplained refusal. Whole gigabytes are rendered as such and
 * everything else falls through to `megabytes`, so every existing caller's copy is unchanged
 * to the byte (512MB included).
 *
 * Derivation, not formatting, is the point it inherits: the argument is always the constant
 * the check enforces, never a number typed beside it.
 *
 * KNOWN LIMITATION, left in place deliberately. Only WHOLE gigabytes take the GB form, so a
 * cap of 1.5GB renders as '1536MB' — the exact unreadability this function was added to
 * avoid, arrived at from the other side. No caller is anywhere near that today (the largest
 * is MAX_ENTITY_SIZE at exactly 2GB), so the behaviour is not reachable and changing it now
 * would move existing copy for no user. It is written down so the next person who sets a
 * fractional-gigabyte cap finds it here rather than in a screenshot from production.
 */
export function sizeLimitLabel(bytes: number): string {
  const gigabytes = bytes / 1024 / 1024 / 1024;
  if (gigabytes >= 1 && Number.isInteger(gigabytes)) return `${gigabytes}GB`;
  return megabytes(bytes);
}

/** The copy a single route needs so its `MulterError` responses can tell the truth. */
export interface MulterErrorCopy {
  /**
   * What this route actually accepts, as a whole sentence — the cap the USER is subject to,
   * which is the handler's tighter check where there is one, not multer's route ceiling.
   * e.g. 'Videos can be up to 50MB and other files up to 25MB.'
   */
  tooLarge: string;
  /** The most files this route takes at once. Only for routes accepting more than one. */
  maxFiles?: number;
}

/**
 * Maps a `MulterError` to a status and a user-facing sentence.
 *
 * 413 for the genuine limit family (the request really was too large), 400 for the two
 * codes that mean the multipart body was malformed rather than oversized.
 */
function describe(err: MulterError, copy?: MulterErrorCopy): { status: number; message: string } {
  // Widened to `string` deliberately. @types/multer's `ErrorCode` union lags the runtime —
  // multer 2.2.0 raises LIMIT_FIELD_NESTING, which the union does not list — and a code the
  // types have not caught up to must still get a real answer rather than fall through to
  // the blanket 500 this middleware exists to prevent. `default` covers anything unlisted.
  switch (err.code as string) {
    case 'LIMIT_FILE_SIZE':
      return {
        status: 413,
        message: copy?.tooLarge ?? 'That file is too large to upload. Please try a smaller file.',
      };
    case 'LIMIT_FILE_COUNT':
      return {
        status: 413,
        message: copy?.maxFiles
          ? `Too many files. You can attach up to ${copy.maxFiles} files at a time.`
          : 'Too many files. Please attach fewer files and try again.',
      };
    case 'LIMIT_PART_COUNT':
    case 'LIMIT_FIELD_COUNT':
      return { status: 413, message: 'That upload had too many parts. Please try again with fewer fields.' };
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
    case 'LIMIT_FIELD_NESTING':
      return { status: 413, message: 'One of the fields in that upload was too long. Please shorten it and try again.' };
    case 'LIMIT_UNEXPECTED_FILE':
    case 'MISSING_FIELD_NAME':
      // Not a size problem — the client sent a file the route did not ask for, or an
      // unnamed part. Almost always a malformed request rather than user error.
      return { status: 400, message: 'That upload was not formed correctly. Please attach the file again and try once more.' };
    default:
      return { status: 400, message: 'That upload could not be read. Please attach the file again and try once more.' };
  }
}

/**
 * Responds to a `MulterError` raised by the multer middleware directly before it.
 *
 * MOUNT IT IMMEDIATELY AFTER THE MULTER MIDDLEWARE AND BEFORE `withOrgContext`. An abort
 * skips every ordinary middleware behind it and resumes at the next ERROR handler, so the
 * position is not what makes it reachable — adjacency is what keeps a limit and the
 * sentence describing it reviewable in one glance, which is the only defence against the
 * two drifting apart.
 *
 * The body uses the `error` key, and ONLY that key. The frontend's `extractApiError`
 * reads `response.data.error` (and prefers a `details[]` array over it); a `{ success,
 * message }` body — the shape the unused `errorHandler.ts` in this directory returns —
 * would give it nothing to read and the toast would degrade to the axios default,
 * "Request failed with status code 413", which is no better than the 500 this replaces.
 */
export function multerErrorHandler(copy: MulterErrorCopy) {
  return function handleMulterError(err: unknown, req: Request, res: Response, next: NextFunction): void {
    if (!(err instanceof MulterError)) {
      next(err);
      return;
    }

    const { status, message } = describe(err, copy);
    logger.warn('Upload rejected by multer', {
      code: err.code,
      field: err.field,
      path: req.originalUrl,
      status,
    });
    res.status(status).json({ error: message });
  };
}

/**
 * App-level net for a multipart route with no handler of its own. Register it AFTER the
 * routers and before the blanket 500 handler. Names no size, on purpose — see the header.
 */
export function globalMulterErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (!(err instanceof MulterError)) {
    next(err);
    return;
  }

  const { status, message } = describe(err);
  // Worth a log line at error level unlike the per-route case: reaching here means a
  // multipart route was added without the route-accurate handler, so this user just got
  // a vaguer message than they should have.
  logger.error('Upload rejected by multer on a route with no MulterError handler', {
    code: err.code,
    field: err.field,
    path: req.originalUrl,
    status,
  });
  res.status(status).json({ error: message });
}
