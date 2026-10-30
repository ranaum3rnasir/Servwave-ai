import type { Request, Response } from 'express';

/**
 * The server check behind the "Standalone estimates" and "Standalone invoices" switches: making an
 * estimate with no lead and no job, or an invoice with no job, needs its own switch. An estimate on a
 * lead or job and an invoice on a job follow Create estimates and Create invoices alone.
 */

export const STANDALONE_REFUSAL = {
  Estimate: 'You do not have permission to create an estimate without a lead or job.',
  Invoice: 'You do not have permission to create an invoice without a job.',
} as const;

/**
 * Answers 403 and returns true when the person lacks the switch for a document that hangs off a
 * customer alone; the caller returns. Returns false, writing nothing, when they hold it.
 */
export function refusedForStandalone(req: Request, res: Response, subject: keyof typeof STANDALONE_REFUSAL): boolean {
  if (req.ability?.can('create_standalone', subject)) return false;
  res.status(403).json({ error: STANDALONE_REFUSAL[subject] });
  return true;
}
