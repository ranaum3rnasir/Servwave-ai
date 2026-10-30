import type { Request } from 'express';

/**
 * The longest token a customer link carries. Tokens are minted as UUIDs (36 characters); the ceiling leaves room for older
 * or hand-made tokens while refusing a megabyte of text before it reaches the database.
 */
const MAX_TOKEN_LENGTH = 256;

/**
 * The private token of a customer's estimate or invoice link (`?token=`), or null when the request does not carry one as a
 * single, non-empty piece of plain text.
 *
 * Express's query parser turns `?token[not]=x` into an object and `?token=a&token=b` into a list. Handed to Prisma as the
 * token, an object is a FILTER ("any token but x"), so the record id alone would open the link (re-audit N0). Every link door
 * reads its token through here and answers "not found" to null, exactly as it does to a wrong token.
 */
export function publicLinkToken(req: Request): string | null {
  const token: unknown = req.query.token;
  if (typeof token !== 'string') return null;
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  return token;
}
