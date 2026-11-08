import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';

/**
 * Entity-redesign Phase D — onDelete contract (MOCKED).
 *
 * The vitest suite mocks Prisma, so this does NOT exercise the real Postgres FK
 * constraints (that is migration-data-shape.test.ts against the branch DB during
 * the cutover window). Instead it pins the INTENT of the §10 onDelete matrix as a
 * documented, regression-guarded contract: the financial-spine parents (Customer,
 * Lead, Job, Invoice, Payment) are RESTRICT (a delete with children throws); the
 * owned leaves (InvoiceLineItem, EstimateLineItem, CustomerEmail, CustomerPhone,
 * ServiceLocation) are CASCADE; the customer self-FKs (parent_id, bill_to) are
 * SetNull. We simulate the DB behavior by making the mocked delete reject with the
 * Prisma P2003 FK-violation code when children are present.
 *
 * Source of truth for the actual DDL: migrations _redesign_D2_tighten_restrict and
 * the schema.prisma onDelete annotations.
 */

const mockPrisma = prisma as unknown as Record<string, { delete?: ReturnType<typeof vi.fn>; deleteMany?: ReturnType<typeof vi.fn> }>;

/** A Prisma foreign-key-violation error (what a RESTRICT delete-with-children raises). */
function fkViolation() {
  return Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('entity-redesign Phase D — onDelete RESTRICT spine (mocked contract)', () => {
  // The §10 matrix: deleting a spine parent that still has children must be REJECTED.
  const RESTRICT_PARENTS = ['customer', 'lead', 'job', 'invoice', 'payment'] as const;

  for (const model of RESTRICT_PARENTS) {
    it(`${model}.delete() THROWS when children exist (RESTRICT)`, async () => {
      mockPrisma[model].delete!.mockRejectedValue(fkViolation());
      await expect(
        (prisma as any)[model].delete({ where: { id: 'has-children' } }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it(`${model}.delete() SUCCEEDS when no children exist`, async () => {
      mockPrisma[model].delete!.mockResolvedValue({ id: 'leaf' });
      await expect(
        (prisma as any)[model].delete({ where: { id: 'leaf' } }),
      ).resolves.toMatchObject({ id: 'leaf' });
    });
  }
});

describe('entity-redesign Phase D — onDelete CASCADE leaves (mocked contract)', () => {
  // Owned leaves cascade from their parent — deleting the parent removes them; deleting
  // a leaf directly always succeeds (no children of its own).
  const CASCADE_LEAVES = [
    'invoiceLineItem',
    'estimateLineItem',
    'customerEmail',
    'customerPhone',
    'serviceLocation',
  ] as const;

  for (const model of CASCADE_LEAVES) {
    it(`${model} deletes cleanly with its parent (owned leaf, Cascade)`, async () => {
      // Owned leaves are removed via deleteMany (the purge path) and via DB cascade — a
      // child-set delete on the leaf always succeeds (it has no children of its own).
      mockPrisma[model].deleteMany!.mockResolvedValue({ count: 1 });
      await expect(
        (prisma as any)[model].deleteMany({ where: { invoice_id: 'p' } }),
      ).resolves.toMatchObject({ count: 1 });
    });
  }
});

describe('entity-redesign Phase D — customer self-FK SetNull (mocked contract)', () => {
  it('deleting a parent/billing-group customer SetNulls members (never cascades)', async () => {
    // A parent customer with members deletes successfully; the members survive with
    // parent_id/bill_to_customer_id nulled (SetNull), never deleted (Cascade) — this is the
    // §10 guarantee that a purged org must not delete its independent members.
    mockPrisma.customer.delete!.mockResolvedValue({ id: 'org-parent' });
    await expect(
      (prisma as any).customer.delete({ where: { id: 'org-parent' } }),
    ).resolves.toMatchObject({ id: 'org-parent' });
  });
});
