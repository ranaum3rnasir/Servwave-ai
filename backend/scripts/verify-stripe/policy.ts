/**
 * Payments go-live slice 39 - what a verification run may delete.
 *
 * The suite writes its own rows (customers, invoices, payments, sometimes whole orgs). On a
 * database on this machine it removes them again. On a shared database (staging) it never runs a
 * DELETE: it leaves the rows, and the report lists what it created. Nothing here can force a
 * delete on a shared database.
 */

/** True only for a database server on this machine. Anything unparseable counts as shared. */
export function databaseIsLocal(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export function keepFixtures(env: { DATABASE_URL?: string; VERIFY_STRIPE_KEEP_FIXTURES?: string }): boolean {
  if (!databaseIsLocal(env.DATABASE_URL)) return true;
  return env.VERIFY_STRIPE_KEEP_FIXTURES === '1';
}
