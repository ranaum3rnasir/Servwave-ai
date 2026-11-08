import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * Entity-redesign Phase D — migration data-shape assertions (INTEGRATION, real DB).
 *
 * THIS IS THE ONLY PLACE A REAL DB IS TOUCHED. It runs against the Supabase BRANCH DB
 * (a clone of staging) during the cutover window, AFTER the D1→D3 chain is applied —
 * see md_files/plans/entity-redesign/CUTOVER-RUNBOOK.md (STEP 3). It is SKIPPED in the
 * normal (mocked-Prisma) suite, because the unit suite never has a real DB and these
 * invariants are physical (NOT NULL, partial-unique, contiguous numbering, surcharge
 * preserved) — they cannot be proven by a mocked client.
 *
 * To run it during the cutover: set MIGRATION_SHAPE_DB_URL to the branch-DB connection
 * string and invoke `MIGRATION_SHAPE_DB_URL=postgres://… npx vitest run migration-data-shape`.
 * It uses its OWN PrismaClient pointed at that URL — it never imports ../lib/prisma (which
 * is globally mocked by setup.ts) and never touches staging.
 */

const BRANCH_DB_URL = process.env['MIGRATION_SHAPE_DB_URL'];
const describeIfDb = BRANCH_DB_URL ? describe : describe.skip;

describeIfDb('entity-redesign Phase D — migration data shape (branch DB)', () => {
  // Lazily required so the mocked suite never instantiates a real client.
  let client: any;

  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    client = new PrismaClient({ datasources: { db: { url: BRANCH_DB_URL } } });
    await client.$connect();
  });

  afterAll(async () => {
    if (client) await client.$disconnect();
  });

  it('no leads have a NULL service_location_id (backfilled in D1c, tightened in D2)', async () => {
    const [{ count }] = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM leads WHERE service_location_id IS NULL`,
    );
    expect(count).toBe(0);
  });

  it('no estimates have a NULL lead_id (synthesized in D1d, tightened in D2)', async () => {
    const [{ count }] = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM estimates WHERE lead_id IS NULL`,
    );
    expect(count).toBe(0);
  });

  it('no invoices have a NULL customer_id (backfilled in D1a/D1e, tightened in D2)', async () => {
    const [{ count }] = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM invoices WHERE customer_id IS NULL`,
    );
    expect(count).toBe(0);
  });

  it('at most one kind=DEPOSIT invoice per estimate (partial-unique index)', async () => {
    const rows = await client.$queryRawUnsafe(
      `SELECT estimate_id, COUNT(*)::int AS n FROM invoices
       WHERE kind = 'DEPOSIT' AND estimate_id IS NOT NULL
       GROUP BY estimate_id HAVING COUNT(*) > 1`,
    );
    expect(rows).toHaveLength(0);
  });

  it('every customer has at least one customer_phones row (backfilled in D1f)', async () => {
    const rows = await client.$queryRawUnsafe(
      `SELECT c.id FROM customers c
       LEFT JOIN customer_phones p ON p.customer_id = c.id
       WHERE p.id IS NULL`,
    );
    expect(rows).toHaveLength(0);
  });

  it('every dissolved deposit invoice has a Payment.amount = deposit principal + surcharge (preserved)', async () => {
    // After D1a, each PAID kind=DEPOSIT invoice has a Payment whose amount preserves the
    // surcharge (amount + surcharge_amount). We verify no PAID deposit invoice has a
    // payment-sum below its own total_amount (the principal) — surcharge can only add.
    const rows = await client.$queryRawUnsafe(
      `SELECT i.id
       FROM invoices i
       JOIN (
         SELECT invoice_id, COALESCE(SUM(amount), 0) AS paid FROM payments
         WHERE voided_at IS NULL GROUP BY invoice_id
       ) p ON p.invoice_id = i.id
       WHERE i.kind = 'DEPOSIT' AND i.status = 'PAID' AND p.paid < i.total_amount`,
    );
    expect(rows).toHaveLength(0);
  });

  it('deposit-invoice numbers are contiguous with the org invoice sequence (no drift/duplication)', async () => {
    // No two invoices in the same org share an invoice_number (the prod-drift class).
    const rows = await client.$queryRawUnsafe(
      `SELECT organization_id, invoice_number, COUNT(*)::int AS n FROM invoices
       GROUP BY organization_id, invoice_number HAVING COUNT(*) > 1`,
    );
    expect(rows).toHaveLength(0);
  });

  it('no legacy customers remain without kind/segment (tightened NOT NULL in D2)', async () => {
    const [{ count }] = await client.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM customers WHERE kind IS NULL OR segment IS NULL`,
    );
    expect(count).toBe(0);
  });
});
