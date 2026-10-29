import express, { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Tighter JSON body ceilings for the unauthenticated routes (GHSA-mrhx-c7xc-m3w5 hardening).
 *
 * Anyone can reach these without an account, so they should only buffer and parse what a real
 * request to them can carry, not the app-wide 1mb. Mounted in app.ts BEFORE the global
 * `express.json({ limit: '1mb' })`: body-parser marks a parsed request (`req._body`) and the
 * global parser then skips it, so the tighter limit here is the one that applies. A parser placed
 * after the global one would never run.
 *
 * Paths are matched case-insensitively with an optional trailing slash, and with runs of slashes
 * collapsed, the same way Express routes them (a router mounted at /api/estimates also answers
 * /api/estimates//:id/...), so a re-spelled path cannot reach the handler under the 1mb ceiling.
 *
 * Each limit is above the route's largest real body:
 * - approve: a signature image (zod-capped at 500,000 chars) plus up to 200 selections (~18KB).
 * - decline: a free-text note the page caps at 20,000 characters. Raw UTF-8 is up to 3 bytes a
 *   character; a JSON-escaped one (\uXXXX) is 6, so even a fully escaped note is at most ~120KB.
 * - everything else: ids, a token, a few flags or small numbers, or a password - a few KB at most.
 */
export const PUBLIC_JSON_LIMIT = '64kb';
export const PUBLIC_DECLINE_JSON_LIMIT = '128kb';
export const PUBLIC_APPROVE_JSON_LIMIT = '640kb';

const ID = '[^/]+';

export const PUBLIC_BODY_LIMITS: { path: RegExp; limit: string }[] = [
  { path: new RegExp(`^/api/estimates/${ID}/approve/?$`, 'i'), limit: PUBLIC_APPROVE_JSON_LIMIT },
  { path: new RegExp(`^/api/estimates/${ID}/decline/?$`, 'i'), limit: PUBLIC_DECLINE_JSON_LIMIT },
  { path: new RegExp(`^/api/estimates/${ID}/(public(/${ID})?|decline-reasons)/?$`, 'i'), limit: PUBLIC_JSON_LIMIT },
  { path: new RegExp(`^/api/invoices/${ID}/public(/${ID})?/?$`, 'i'), limit: PUBLIC_JSON_LIMIT },
  // The whole auth router: its signed-in routes (logout, MFA setup) carry small bodies too.
  { path: /^\/api\/auth(\/.*)?$/i, limit: PUBLIC_JSON_LIMIT },
];

/** Generic on purpose: they name no limit and echo nothing from the body. */
export const PUBLIC_BODY_TOO_LARGE_MESSAGE = 'This request is too large.';
export const PUBLIC_BODY_UNREADABLE_MESSAGE = 'This request could not be read.';
export const PUBLIC_BODY_UNSUPPORTED_MESSAGE = 'This request is in an unsupported format.';

/** The limit for `path`, or null when the path is not one of the public routes. */
export function publicBodyLimitFor(path: string): string | null {
  const normalized = path.replace(/\/{2,}/g, '/');
  return PUBLIC_BODY_LIMITS.find((r) => r.path.test(normalized))?.limit ?? null;
}

/**
 * body-parser's own 4xx (malformed JSON, an unsupported charset or encoding, a too-large body) as a
 * short JSON answer with its status, instead of the terminal handler's 500. Anything else passes on.
 */
function bodyParserRefusal(err: unknown): { status: number; error: string } | null {
  const e = err as { type?: string; status?: number } | undefined;
  if (e?.type === 'entity.too.large') return { status: 413, error: PUBLIC_BODY_TOO_LARGE_MESSAGE };
  const status = e?.status;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  return { status, error: status === 415 ? PUBLIC_BODY_UNSUPPORTED_MESSAGE : PUBLIC_BODY_UNREADABLE_MESSAGE };
}

export function publicBodyLimit(): RequestHandler {
  const parsers = new Map<string, RequestHandler>(
    [...new Set(PUBLIC_BODY_LIMITS.map((r) => r.limit))].map((limit) => [limit, express.json({ limit })]),
  );
  return (req: Request, res: Response, next: NextFunction) => {
    const limit = publicBodyLimitFor(req.path);
    if (!limit) return next();
    parsers.get(limit)!(req, res, (err?: unknown) => {
      const refusal = err ? bodyParserRefusal(err) : null;
      if (refusal) {
        res.status(refusal.status).json({ error: refusal.error });
        return;
      }
      next(err);
    });
  };
}
