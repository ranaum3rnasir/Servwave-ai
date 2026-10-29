/**
 * filterByAccess.test.ts — TDD tests for Task 2.4 CASL row-scope recipient filter
 *
 * Covers:
 * 1. SALES recipient who CANNOT access a Lead is filtered OUT;
 *    TECH who CAN access a Job is KEPT.
 * 2. Non-scoped object type (e.g. 'INVENTORY_ITEM') returns ALL recipientIds
 *    and does NOT call canAccessRow.
 * 3. Fail-closed: when canAccessRow THROWS for a recipient, that recipient is DROPPED.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { filterRecipientsByAccess } from '../filterByAccess';
import { prisma } from '../../../lib/prisma';
import { canAccessRow } from '../../../lib/permissions/enforce';

// Mock canAccessRow from enforce.ts
vi.mock('../../../lib/permissions/enforce', () => ({
  canAccessRow: vi.fn(),
  // scopeWhereForReq and can are not used by filterByAccess, include for completeness
  scopeWhereForReq: vi.fn(),
  can: vi.fn(),
}));

// Mock grant/override loaders so we don't hit DB for ability construction
vi.mock('../../../lib/permissions/permissionCache', () => ({
  getCachedGrants: vi.fn().mockReturnValue([]),
  setCachedGrants: vi.fn(),
  clearPermissionCache: vi.fn(),
}));

vi.mock('../../../lib/permissions/loadUserOverrides', () => ({
  loadUserOverrides: vi.fn().mockResolvedValue([]),
}));

const mockCanAccessRow = vi.mocked(canAccessRow);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: rolePermission.findMany returns empty grants
  (prisma.rolePermission.findMany as any).mockResolvedValue([]);
  // Default: userPermissionOverride.findMany returns no overrides
  (prisma.userPermissionOverride.findMany as any).mockResolvedValue([]);
});

describe('filterRecipientsByAccess', () => {
  // ── Case 1: scoped types — CASL row access enforced per recipient ──────────

  describe('scoped object type — Lead', () => {
    it('drops a SALES recipient who cannot access the Lead', async () => {
      const salesUserId = 'user-sales-1';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: salesUserId, role: 'SALES', organization_id: 'org1' },
      ]);
      mockCanAccessRow.mockResolvedValueOnce(false);

      const result = await filterRecipientsByAccess('LEAD', 'lead-abc', [salesUserId], 'org1');

      expect(result).toEqual([]);
      expect(mockCanAccessRow).toHaveBeenCalledOnce();
    });

    it('keeps a SALES recipient who CAN access the Lead', async () => {
      const salesUserId = 'user-sales-2';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: salesUserId, role: 'SALES', organization_id: 'org1' },
      ]);
      mockCanAccessRow.mockResolvedValueOnce(true);

      const result = await filterRecipientsByAccess('LEAD', 'lead-xyz', [salesUserId], 'org1');

      expect(result).toEqual([salesUserId]);
    });

    it('handles lowercase objectType the same as uppercase (LEAD = lead)', async () => {
      const userId = 'user-tech-1';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: userId, role: 'TECHNICIAN', organization_id: 'org1' },
      ]);
      mockCanAccessRow.mockResolvedValueOnce(true);

      const result = await filterRecipientsByAccess('lead', 'lead-lower', [userId], 'org1');
      expect(result).toEqual([userId]);
    });
  });

  describe('scoped object type — Job', () => {
    it('keeps a TECHNICIAN who CAN access the Job', async () => {
      const techUserId = 'user-tech-2';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: techUserId, role: 'TECHNICIAN', organization_id: 'org1' },
      ]);
      mockCanAccessRow.mockResolvedValueOnce(true);

      const result = await filterRecipientsByAccess('JOB', 'job-abc', [techUserId], 'org1');

      expect(result).toEqual([techUserId]);
      expect(mockCanAccessRow).toHaveBeenCalledOnce();
    });

    it('drops a TECHNICIAN who CANNOT access the Job', async () => {
      const techUserId = 'user-tech-3';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: techUserId, role: 'TECHNICIAN', organization_id: 'org1' },
      ]);
      mockCanAccessRow.mockResolvedValueOnce(false);

      const result = await filterRecipientsByAccess('JOB', 'job-xyz', [techUserId], 'org1');

      expect(result).toEqual([]);
    });

    it('correctly partitions: keeps allowed, drops denied, preserves input order', async () => {
      const tech1 = 'user-tech-a';
      const tech2 = 'user-tech-b';
      const disp1 = 'user-disp-c';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: tech1, role: 'TECHNICIAN', organization_id: 'org1' },
        { id: tech2, role: 'TECHNICIAN', organization_id: 'org1' },
        { id: disp1, role: 'DISPATCHER', organization_id: 'org1' },
      ]);
      // tech1 can → keep, tech2 cannot → drop, disp1 can → keep
      mockCanAccessRow
        .mockResolvedValueOnce(true)   // tech1
        .mockResolvedValueOnce(false)  // tech2
        .mockResolvedValueOnce(true);  // disp1

      const result = await filterRecipientsByAccess(
        'JOB',
        'job-multi',
        [tech1, tech2, disp1],
        'org1',
      );

      expect(result).toEqual([tech1, disp1]);
    });
  });

  describe('ADMIN recipients always pass canAccessRow (ADMIN ability = manage all)', () => {
    it('calls canAccessRow for ADMIN — the empty-scope fast-path is inside canAccessRow itself', async () => {
      // ADMIN: defineAbilityFor gives manage:all → canAccessRow gets empty scope → fast-path true
      // canAccessRow IS called; it returns true immediately via its own fast-path.
      const adminId = 'user-admin-1';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: adminId, role: 'ADMIN', organization_id: 'org1' },
      ]);
      mockCanAccessRow.mockResolvedValueOnce(true);

      const result = await filterRecipientsByAccess('INVOICE', 'inv-1', [adminId], 'org1');
      expect(result).toEqual([adminId]);
      expect(mockCanAccessRow).toHaveBeenCalledOnce();
    });
  });

  // ── Regression: select must include department_id + location_id for scope fields ──

  describe('select includes department_id and location_id for scoped types', () => {
    it('calls prisma.user.findMany with department_id: true and location_id: true in the select', async () => {
      const userId = 'user-scoped-1';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: userId, role: 'SALES', organization_id: 'org1', department_id: null, location_id: null },
      ]);
      mockCanAccessRow.mockResolvedValueOnce(true);

      await filterRecipientsByAccess('LEAD', 'lead-scope-test', [userId], 'org1');

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            department_id: true,
            location_id: true,
          }),
        }),
      );
    });
  });

  // ── Case 2: non-scoped type — passthrough, canAccessRow never called ───────

  describe('non-scoped object types', () => {
    it('returns all recipientIds unchanged for INVENTORY_ITEM', async () => {
      const ids = ['u1', 'u2', 'u3'];

      const result = await filterRecipientsByAccess('INVENTORY_ITEM', 'item-123', ids, 'org1');

      expect(result).toEqual(ids);
      expect(mockCanAccessRow).not.toHaveBeenCalled();
      // prisma.user.findMany must NOT have been called either
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns all recipientIds unchanged for TASK', async () => {
      const ids = ['u4', 'u5'];
      const result = await filterRecipientsByAccess('TASK', 'task-abc', ids, 'org1');
      expect(result).toEqual(ids);
      expect(mockCanAccessRow).not.toHaveBeenCalled();
    });

    it('returns empty array for non-scoped type when input is empty', async () => {
      const result = await filterRecipientsByAccess('INVENTORY_ITEM', 'item-x', [], 'org1');
      expect(result).toEqual([]);
      expect(mockCanAccessRow).not.toHaveBeenCalled();
    });
  });

  // ── Case 3: fail-closed — canAccessRow throws → DROP + warn ────────────────

  describe('fail-closed on canAccessRow error', () => {
    it('drops a recipient when canAccessRow throws, and keeps others that pass', async () => {
      const flakyUserId = 'user-flaky';
      const goodUserId = 'user-good';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: flakyUserId, role: 'DISPATCHER', organization_id: 'org1' },
        { id: goodUserId, role: 'DISPATCHER', organization_id: 'org1' },
      ]);
      mockCanAccessRow
        .mockRejectedValueOnce(new Error('DB timeout'))  // flakyUserId → throw
        .mockResolvedValueOnce(true);                    // goodUserId → keep

      const result = await filterRecipientsByAccess(
        'ESTIMATE',
        'est-1',
        [flakyUserId, goodUserId],
        'org1',
      );

      expect(result).toEqual([goodUserId]);
    });

    it('drops ALL recipients when canAccessRow throws for every one', async () => {
      const u1 = 'user-err-1';
      const u2 = 'user-err-2';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: u1, role: 'SALES', organization_id: 'org1' },
        { id: u2, role: 'SALES', organization_id: 'org1' },
      ]);
      mockCanAccessRow.mockRejectedValue(new Error('casl explosion'));

      const result = await filterRecipientsByAccess('JOB', 'job-err', [u1, u2], 'org1');

      expect(result).toEqual([]);
    });

    it('drops a recipient who is NOT found in the org (missing user → fail-closed)', async () => {
      const ghostId = 'user-ghost';
      // user.findMany returns empty — ghost is not in the org
      (prisma.user.findMany as any).mockResolvedValue([]);

      const result = await filterRecipientsByAccess('JOB', 'job-ghost', [ghostId], 'org1');

      expect(result).toEqual([]);
      expect(mockCanAccessRow).not.toHaveBeenCalled();
    });
  });
});
