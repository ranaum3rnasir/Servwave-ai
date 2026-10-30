/**
 * filterByAccess.test.ts — the row-scope recipient filter (Task 2.4)
 *
 * Covers:
 * 1. SALES recipient who CANNOT access a Lead is filtered OUT;
 *    TECH who CAN access a Job is KEPT.
 * 2. Non-scoped object type (e.g. 'INVENTORY_ITEM') returns ALL recipientIds
 *    and reads nothing.
 * 3. Fail-closed: when the access check THROWS for a recipient, that recipient is DROPPED.
 * 4. Everyone is asked together: the people's switches are read once for all of them, and the people whose scope
 *    restricts the row are looked at in one batch, never one at a time.
 *
 * The scope a person holds (scopeWhereForUser) and the batched look at the row (readersWithEntityAccess) are the
 * collaborators; the real-database suites (notification-fan-out-db, permission-switch-cache-partial-user-db) run the
 * real ones.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { filterRecipientsByAccess } from '../filterByAccess';
import { prisma } from '../../../lib/prisma';
import { scopeWhereForUser } from '../../../lib/permissions/enforce';
import { readersWithEntityAccess } from '../../../lib/tasks/entityAccessCohort';
import { resolveSwitchesForPeople } from '../../../lib/permissions/switches/store';
import { readersOfConversation } from '../../../lib/communication/conversationReaders';

vi.mock('../../../lib/permissions/enforce', () => ({
  scopeWhereForUser: vi.fn(),
}));
vi.mock('../../../lib/tasks/entityAccessCohort', () => ({
  readersWithEntityAccess: vi.fn(),
}));
vi.mock('../../../lib/permissions/switches/store', () => ({
  resolveSwitchesForPeople: vi.fn(),
}));
vi.mock('../../../lib/communication/conversationReaders', () => ({
  readersOfConversation: vi.fn(),
}));

const mockScope = vi.mocked(scopeWhereForUser);
const mockReaders = vi.mocked(readersWithEntityAccess);

const RESTRICTED = { organization_id: 'org1', visits: { some: {} } };

/** The row-scope each person holds: `{}` reaches every row, anything else restricts. */
function scopes(byId: Record<string, Record<string, unknown>>) {
  mockScope.mockImplementation(async (user) => byId[user.id] ?? RESTRICTED);
}

/** Who the batched look at the row lets in. */
function lookLetsIn(...ids: string[]) {
  mockReaders.mockResolvedValue({ withAccess: new Set(ids), probes: 1, fallbacks: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveSwitchesForPeople).mockResolvedValue(new Map());
});

describe('filterRecipientsByAccess', () => {
  // ── Case 1: scoped types — row access enforced per recipient ───────────────

  describe('scoped object type — Lead', () => {
    it('drops a SALES recipient who cannot access the Lead', async () => {
      const salesUserId = 'user-sales-1';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: salesUserId, role: 'SALES', organization_id: 'org1' },
      ]);
      scopes({});
      lookLetsIn();

      const result = await filterRecipientsByAccess('LEAD', 'lead-abc', [salesUserId], 'org1');

      expect(result).toEqual([]);
      expect(mockReaders).toHaveBeenCalledOnce();
    });

    it('keeps a SALES recipient who CAN access the Lead', async () => {
      const salesUserId = 'user-sales-2';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: salesUserId, role: 'SALES', organization_id: 'org1' },
      ]);
      scopes({});
      lookLetsIn(salesUserId);

      const result = await filterRecipientsByAccess('LEAD', 'lead-xyz', [salesUserId], 'org1');

      expect(result).toEqual([salesUserId]);
    });

    it('handles lowercase objectType the same as uppercase (LEAD = lead)', async () => {
      const userId = 'user-tech-1';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: userId, role: 'TECHNICIAN', organization_id: 'org1' },
      ]);
      scopes({});
      lookLetsIn(userId);

      const result = await filterRecipientsByAccess('lead', 'lead-lower', [userId], 'org1');
      expect(result).toEqual([userId]);
      expect(mockReaders).toHaveBeenCalledWith(expect.anything(), { type: 'LEAD', id: 'lead-lower' });
    });
  });

  describe('scoped object type — Job', () => {
    it('keeps a TECHNICIAN who CAN access the Job', async () => {
      const techUserId = 'user-tech-2';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: techUserId, role: 'TECHNICIAN', organization_id: 'org1' },
      ]);
      scopes({});
      lookLetsIn(techUserId);

      const result = await filterRecipientsByAccess('JOB', 'job-abc', [techUserId], 'org1');

      expect(result).toEqual([techUserId]);
      expect(mockReaders).toHaveBeenCalledOnce();
    });

    it('drops a TECHNICIAN who CANNOT access the Job', async () => {
      const techUserId = 'user-tech-3';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: techUserId, role: 'TECHNICIAN', organization_id: 'org1' },
      ]);
      scopes({});
      lookLetsIn();

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
      // tech1 can → keep, tech2 cannot → drop, disp1 can → keep (the Dispatcher's scope restricts nothing)
      scopes({ [disp1]: {} });
      lookLetsIn(tech1);

      const result = await filterRecipientsByAccess(
        'JOB',
        'job-multi',
        [tech1, tech2, disp1],
        'org1',
      );

      expect(result).toEqual([tech1, disp1]);
      // Only the two whose scope restricts the row are looked at, together.
      expect(mockReaders).toHaveBeenCalledOnce();
      expect(mockReaders.mock.calls[0]![0].map((u) => u.id)).toEqual([tech1, tech2]);
    });
  });

  describe('ADMIN recipients always pass (ADMIN ability = manage all)', () => {
    it('keeps an ADMIN without looking at the row: the empty scope reaches every row', async () => {
      const adminId = 'user-admin-1';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: adminId, role: 'ADMIN', organization_id: 'org1' },
      ]);
      scopes({ [adminId]: {} });

      const result = await filterRecipientsByAccess('INVOICE', 'inv-1', [adminId], 'org1');
      expect(result).toEqual([adminId]);
      expect(mockReaders).not.toHaveBeenCalled();
    });
  });

  // ── Regression: select must include department_id + location_id for scope fields ──

  describe('select includes department_id and location_id for scoped types', () => {
    it('calls prisma.user.findMany with department_id: true and location_id: true in the select', async () => {
      const userId = 'user-scoped-1';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: userId, role: 'SALES', organization_id: 'org1', department_id: null, location_id: null },
      ]);
      scopes({});
      lookLetsIn(userId);

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

  // ── A recipient on a custom role is judged as that role, not as its base role ──

  describe('recipient on a custom role', () => {
    it('judges the person with their custom role, for their switches and for their scope', async () => {
      const userId = 'user-custom-1';
      (prisma.user.findMany as any).mockResolvedValue([
        {
          id: userId, role: 'DISPATCHER', organization_id: 'org1', department_id: null, location_id: null,
          custom_role_id: 'role-1', custom_role: { key: 'bare-office' },
        },
      ]);
      scopes({});
      lookLetsIn(userId);

      await filterRecipientsByAccess('JOB', 'job-custom', [userId], 'org1');

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ custom_role_id: true, custom_role: { select: { key: true } } }),
        }),
      );
      const person = expect.objectContaining({ id: userId, custom_role_id: 'role-1', custom_role: { key: 'bare-office' } });
      expect(resolveSwitchesForPeople).toHaveBeenCalledWith([person]);
      expect(mockScope).toHaveBeenCalledWith(person, 'Job');
      expect(mockReaders).toHaveBeenCalledWith([person], { type: 'JOB', id: 'job-custom' });
    });
  });

  // ── Everyone is asked together ──────────────────────────────────────────────

  describe('a large roster', () => {
    it('reads everyone\'s switches once and looks at the row once, however many recipients there are', async () => {
      const ids = Array.from({ length: 120 }, (_, i) => `user-${i}`);
      (prisma.user.findMany as any).mockResolvedValue(ids.map((id) => ({ id, role: 'TECHNICIAN', organization_id: 'org1' })));
      scopes({});
      lookLetsIn(...ids.filter((_, i) => i % 2 === 0));

      const result = await filterRecipientsByAccess('JOB', 'job-big', ids, 'org1');

      expect(result).toEqual(ids.filter((_, i) => i % 2 === 0));
      expect(resolveSwitchesForPeople).toHaveBeenCalledOnce();
      expect(mockReaders).toHaveBeenCalledOnce();
      expect(prisma.user.findMany).toHaveBeenCalledOnce();
    });
  });

  // ── Case 2: non-scoped type — passthrough, nothing read ────────────────────

  describe('non-scoped object types', () => {
    it('returns all recipientIds unchanged for INVENTORY_ITEM', async () => {
      const ids = ['u1', 'u2', 'u3'];

      const result = await filterRecipientsByAccess('INVENTORY_ITEM', 'item-123', ids, 'org1');

      expect(result).toEqual(ids);
      expect(mockReaders).not.toHaveBeenCalled();
      expect(mockScope).not.toHaveBeenCalled();
      // prisma.user.findMany must NOT have been called either
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('returns all recipientIds unchanged for TASK', async () => {
      const ids = ['u4', 'u5'];
      const result = await filterRecipientsByAccess('TASK', 'task-abc', ids, 'org1');
      expect(result).toEqual(ids);
      expect(mockReaders).not.toHaveBeenCalled();
    });

    it('returns empty array for non-scoped type when input is empty', async () => {
      const result = await filterRecipientsByAccess('INVENTORY_ITEM', 'item-x', [], 'org1');
      expect(result).toEqual([]);
      expect(mockReaders).not.toHaveBeenCalled();
    });
  });

  // ── Case 3: fail-closed — the check throws → DROP + warn ───────────────────

  describe('fail-closed on an access check error', () => {
    it('drops a recipient whose scope cannot be worked out, and keeps others that pass', async () => {
      const flakyUserId = 'user-flaky';
      const goodUserId = 'user-good';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: flakyUserId, role: 'DISPATCHER', organization_id: 'org1' },
        { id: goodUserId, role: 'DISPATCHER', organization_id: 'org1' },
      ]);
      mockScope.mockImplementation(async (user) => {
        if (user.id === flakyUserId) throw new Error('DB timeout');
        return {};
      });

      const result = await filterRecipientsByAccess(
        'ESTIMATE',
        'est-1',
        [flakyUserId, goodUserId],
        'org1',
      );

      expect(result).toEqual([goodUserId]);
    });

    it('drops everyone whose scope needed the row looked at when the look itself throws, and keeps the open ones', async () => {
      const u1 = 'user-err-1';
      const open = 'user-open';
      (prisma.user.findMany as any).mockResolvedValue([
        { id: u1, role: 'SALES', organization_id: 'org1' },
        { id: open, role: 'DISPATCHER', organization_id: 'org1' },
      ]);
      scopes({ [open]: {} });
      mockReaders.mockRejectedValue(new Error('casl explosion'));

      const result = await filterRecipientsByAccess('JOB', 'job-err', [u1, open], 'org1');

      expect(result).toEqual([open]);
    });

    it('drops a recipient who is NOT found in the org (missing user → fail-closed)', async () => {
      const ghostId = 'user-ghost';
      // user.findMany returns empty — ghost is not in the org
      (prisma.user.findMany as any).mockResolvedValue([]);

      const result = await filterRecipientsByAccess('JOB', 'job-ghost', [ghostId], 'org1');

      expect(result).toEqual([]);
      expect(mockReaders).not.toHaveBeenCalled();
    });

    it('still judges each person on their own when reading everyone\'s switches fails', async () => {
      const userId = 'user-solo';
      (prisma.user.findMany as any).mockResolvedValue([{ id: userId, role: 'SALES', organization_id: 'org1' }]);
      vi.mocked(resolveSwitchesForPeople).mockRejectedValue(new Error('pool timeout'));
      scopes({ [userId]: {} });

      expect(await filterRecipientsByAccess('JOB', 'job-1', [userId], 'org1')).toEqual([userId]);
    });
  });

  // ── Calls, text conversations and email conversations (Roles & Permissions S08.21) ─────────────────────

  describe('communication object types', () => {
    const mockConversationReaders = vi.mocked(readersOfConversation);
    const people = (...ids: string[]) =>
      (prisma.user.findMany as any).mockResolvedValue(ids.map((id) => ({ id, role: 'DISPATCHER', organization_id: 'org1', is_active: true })));
    const whoCanRead = (...ids: string[]) => mockConversationReaders.mockResolvedValue(new Set(ids));

    const CASES = [
      { objectType: 'CALL', kind: 'call' },
      { objectType: 'MESSAGE_THREAD', kind: 'text' },
      { objectType: 'EMAIL_THREAD', kind: 'email' },
    ] as const;

    for (const { objectType, kind } of CASES) {
      describe(`${objectType} (a ${kind})`, () => {
        it('drops a recipient who cannot read it and keeps one who can, in the order given', async () => {
          people('reader-1', 'blocked', 'reader-2');
          whoCanRead('reader-2', 'reader-1');

          const result = await filterRecipientsByAccess(objectType, 'conv-1', ['reader-1', 'blocked', 'reader-2'], 'org1');

          expect(result).toEqual(['reader-1', 'reader-2']);
        });

        it('asks the single-read question once for everyone, never once per person', async () => {
          const ids = Array.from({ length: 80 }, (_, i) => `user-${i}`);
          people(...ids);
          whoCanRead(...ids.filter((_, i) => i % 3 === 0));

          const result = await filterRecipientsByAccess(objectType, 'conv-big', ids, 'org1');

          expect(result).toEqual(ids.filter((_, i) => i % 3 === 0));
          expect(mockConversationReaders).toHaveBeenCalledOnce();
          expect(mockConversationReaders).toHaveBeenCalledWith(expect.any(Array), kind, 'conv-big', 'org1', { messageId: null });
          expect(prisma.user.findMany).toHaveBeenCalledOnce();
        });

        it('hands over the one message an alert quotes, so the question is about that message', async () => {
          people('u1');
          whoCanRead('u1');

          await filterRecipientsByAccess(objectType, 'conv-msg', ['u1'], 'org1', { messageId: 'msg-1' });

          expect(mockConversationReaders).toHaveBeenCalledWith(expect.any(Array), kind, 'conv-msg', 'org1', { messageId: 'msg-1' });
        });

        it('treats the type the same in lower case', async () => {
          people('u1');
          whoCanRead('u1');
          expect(await filterRecipientsByAccess(objectType.toLowerCase(), 'conv-lower', ['u1'], 'org1')).toEqual(['u1']);
          expect(mockConversationReaders).toHaveBeenCalledWith(expect.any(Array), kind, 'conv-lower', 'org1', { messageId: null });
        });

        it('only asks about active people of the company, and drops one who is not found', async () => {
          people('u1');
          whoCanRead('u1', 'ghost');

          const result = await filterRecipientsByAccess(objectType, 'conv-2', ['u1', 'ghost'], 'org1');

          expect(result).toEqual(['u1']);
          expect(prisma.user.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: expect.objectContaining({ organization_id: 'org1', is_active: true }) }),
          );
          const asked = mockConversationReaders.mock.calls[0]![0] as { id: string }[];
          expect(asked.map((p) => p.id)).toEqual(['u1']);
        });

        it('judges a person on a custom role by that role', async () => {
          (prisma.user.findMany as any).mockResolvedValue([
            { id: 'u1', role: 'DISPATCHER', organization_id: 'org1', custom_role_id: 'role-1', custom_role: { key: 'bare-office' } },
          ]);
          whoCanRead('u1');

          await filterRecipientsByAccess(objectType, 'conv-3', ['u1'], 'org1');

          expect(prisma.user.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ select: expect.objectContaining({ custom_role_id: true, custom_role: { select: { key: true } } }) }),
          );
          expect(mockConversationReaders.mock.calls[0]![0]).toEqual([
            expect.objectContaining({ id: 'u1', custom_role_id: 'role-1', custom_role: { key: 'bare-office' } }),
          ]);
        });

        it('fails closed: when the question cannot be answered nobody is kept', async () => {
          people('u1', 'u2');
          mockConversationReaders.mockRejectedValue(new Error('pool timeout'));

          expect(await filterRecipientsByAccess(objectType, 'conv-4', ['u1', 'u2'], 'org1')).toEqual([]);
        });

        it('asks nothing when there is nobody to ask', async () => {
          expect(await filterRecipientsByAccess(objectType, 'conv-5', [], 'org1')).toEqual([]);
          expect(prisma.user.findMany).not.toHaveBeenCalled();
          expect(mockConversationReaders).not.toHaveBeenCalled();
        });

        it('never reads a record row scope: the single read of the conversation is the whole question', async () => {
          people('u1');
          whoCanRead('u1');

          await filterRecipientsByAccess(objectType, 'conv-6', ['u1'], 'org1');

          expect(mockScope).not.toHaveBeenCalled();
          expect(mockReaders).not.toHaveBeenCalled();
        });
      });
    }
  });
});
