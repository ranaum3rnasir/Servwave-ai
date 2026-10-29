import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { writeSettingsAudit } from '../lib/audit';
import { ALPHA_ORG_ID, TEST_USERS } from './helpers';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('writeSettingsAudit', () => {
  it('writes an org-scoped TimelineEvent', async () => {
    (prisma.timelineEvent.create as any).mockResolvedValue({});
    const req: any = { user: { ...TEST_USERS.admin, organization_id: ALPHA_ORG_ID } };
    await writeSettingsAudit(req, 'role.reset', { role: 'SALES' });
    const arg = (prisma.timelineEvent.create as any).mock.calls[0][0].data;
    expect(arg).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      entity_type: 'OrganizationSettings',
      entity_id: ALPHA_ORG_ID,
      event_type: 'role.reset',
      created_by: TEST_USERS.admin.id,
    });
    expect(arg.metadata).toMatchObject({ role: 'SALES' });
  });

  it('swallows errors (audit is best-effort)', async () => {
    (prisma.timelineEvent.create as any).mockRejectedValue(new Error('db down'));
    const req: any = { user: { ...TEST_USERS.admin, organization_id: ALPHA_ORG_ID } };
    await expect(writeSettingsAudit(req, 'x', {})).resolves.toBeUndefined();
  });
});
