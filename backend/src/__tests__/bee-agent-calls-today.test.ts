import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBeeAgents } from '../controllers/bee.controller';
import { prisma } from '../lib/prisma';
import { BeeService } from '../services/bee/beeService';

vi.mock('../lib/prisma', () => ({
  prisma: {
    beeVoiceAgent: {
      findMany: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    beeCallLog: {
      groupBy: vi.fn(),
    },
  },
}));

vi.mock('../services/bee/beeService', () => ({
  BeeService: {
    seedDemoDataIfEmpty: vi.fn().mockResolvedValue(undefined),
    getAvailablePhoneNumbers: vi.fn().mockResolvedValue([]),
    getSampleJobsForAgentContext: vi.fn().mockResolvedValue({ jobs: [] }),
    normalizeAgentRecord: vi.fn((agent) => ({ ...agent })),
  },
}));

vi.mock('../services/bee/beeVoiceAdapter', () => ({
  BeeVoiceAdapter: {},
  BEE_MASTER_PROMPT_TEMPLATE: 'mock-template',
}));

vi.mock('../lib/timezone', () => ({
  getRequestOrgTimezone: vi.fn().mockResolvedValue('America/New_York'),
}));

describe('Bee Agent Calls Today Tracking', () => {
  const orgId = 'org-123';
  const mockReq = {
    user: { organization_id: orgId },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('correctly aggregates calls_today for each agent from prisma.beeCallLog.groupBy', async () => {
    const rawAgents = [
      { id: 'agent-1', name: 'Emma', is_active: true },
      { id: 'agent-2', name: 'Marcus', is_active: true },
      { id: 'agent-3', name: 'Sarah', is_active: false },
    ];

    vi.mocked(prisma.beeVoiceAgent.findMany).mockResolvedValue(rawAgents as any);
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({ name: 'Test Org' } as any);

    // Mock today's counts: agent-1 has 5 calls, agent-2 has 2 calls, agent-3 has 0
    vi.mocked(prisma.beeCallLog.groupBy).mockResolvedValue([
      { agent_id: 'agent-1', _count: { id: 5 } },
      { agent_id: 'agent-2', _count: { id: 2 } },
    ] as any);

    let jsonResponse: any = null;
    const mockRes = {
      json: vi.fn((data) => {
        jsonResponse = data;
        return mockRes;
      }),
      status: vi.fn().mockReturnThis(),
    } as any;

    await getBeeAgents(mockReq, mockRes);

    expect(mockRes.json).toHaveBeenCalledTimes(1);
    expect(jsonResponse.ok).toBe(true);
    expect(jsonResponse.agents).toHaveLength(3);

    const agent1 = jsonResponse.agents.find((a: any) => a.id === 'agent-1');
    const agent2 = jsonResponse.agents.find((a: any) => a.id === 'agent-2');
    const agent3 = jsonResponse.agents.find((a: any) => a.id === 'agent-3');

    // Verify exact counts from DB aggregation (no dummy 38, 9, 12)
    expect(agent1.calls_today).toBe(5);
    expect(agent2.calls_today).toBe(2);
    expect(agent3.calls_today).toBe(0);

    // Verify strict multi-tenant filtering in groupBy
    expect(prisma.beeCallLog.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['agent_id'],
        where: expect.objectContaining({
          organization_id: orgId,
          agent_id: { not: null },
        }),
      })
    );
  });
});
