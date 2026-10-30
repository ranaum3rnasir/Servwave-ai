/** Argument handling for backend/scripts/run-payment-reconcile.ts (kept under src so tests can import it). */

export function parseOrgIds(argv: string[]): string[] | undefined {
  const ids: string[] = [];
  argv.forEach((a, i) => { if (a === '--org' && argv[i + 1]) ids.push(argv[i + 1]); });
  return ids.length ? ids : undefined;
}

/** One line per requested org id that is not an org with a connected payout account. */
export function unknownOrgLines(requested: string[], known: string[]): string[] {
  const have = new Set(known);
  return requested.filter((id) => !have.has(id)).map((id) => `no such org with a payout account: ${id}`);
}
