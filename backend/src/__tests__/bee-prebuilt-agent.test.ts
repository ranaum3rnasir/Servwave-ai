import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { BeeService } from '../services/bee/beeService';
import { validateFlow } from '../services/bee/agentFlow';

describe('Bee Prebuilt Voice Agent on First-Time Setup', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates exactly one prebuilt voice agent mapped to the org job type with a complete conversation flow', async () => {
    // No agent exists yet
    vi.mocked(prisma.beeVoiceAgent.findFirst).mockResolvedValueOnce(null);

    // Mock org record with job types
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: orgId,
      name: 'Apex Heating & Air',
      job_type_options: ['HVAC Maintenance', 'Plumbing', 'Electrical'],
    } as any);

    // Mock beeSetting does not exist yet
    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce(null);

    // Mock create agent returning the created row
    const mockCreatedAgent = {
      id: 'agent-prebuilt-uuid',
      organization_id: orgId,
      name: 'Sarah - HVAC Maintenance Specialist',
      persona_name: 'Sarah',
      voice_id: 'friendly_female_1',
      trade_focus: 'HVAC Maintenance',
      trigger_days_before: 30,
      eligible_job_types: {},
      warranty_offer_pitch: 'pitch',
      new_work_pitch: 'pitch',
      is_active: true,
    };
    vi.mocked(prisma.beeVoiceAgent.create).mockResolvedValueOnce(mockCreatedAgent as any);

    // Mock plan creation check
    vi.mocked(prisma.beeWarrantyPlan.findFirst).mockResolvedValueOnce(null);
    vi.mocked(prisma.beeWarrantyPlan.create).mockResolvedValue({} as any);
    vi.mocked(prisma.beeSetting.create).mockResolvedValue({} as any);

    await BeeService.seedDemoDataIfEmpty(orgId);

    // 1. Exactly ONE agent created
    expect(prisma.beeVoiceAgent.create).toHaveBeenCalledTimes(1);

    const createCallArgs = vi.mocked(prisma.beeVoiceAgent.create).mock.calls[0]![0].data;
    expect(createCallArgs.name).toContain('HVAC Maintenance');
    expect(createCallArgs.persona_name).toBe('Sarah');
    expect(createCallArgs.trade_focus).toBe('HVAC Maintenance');

    // 2. Metadata packed with flow
    const packedJson = createCallArgs.eligible_job_types as any;
    expect(packedJson.eligible_job_types).toEqual(['HVAC Maintenance']);
    expect(packedJson.default_from_number).toBe(''); // No number purchased yet

    // 3. Conversation flow is valid and contains 5 steps
    const flow = packedJson.flow;
    expect(flow).toBeDefined();
    expect(flow.steps).toHaveLength(5);
    expect(flow.steps.map((s: any) => s.id)).toEqual(['opening', 'checkin', 'offer', 'newwork', 'wrap']);
    expect(flow.objections.length).toBeGreaterThan(0);
    expect(flow.guardrails.short_replies).toBe(true);

    const issues = validateFlow(flow);
    const errors = issues.filter((i) => i.level === 'error');
    expect(errors).toEqual([]);

    // 4. BeeSetting created with defaultAgentId pointing to prebuilt agent
    expect(prisma.beeSetting.create).toHaveBeenCalledTimes(1);
    const settingCallArgs = vi.mocked(prisma.beeSetting.create).mock.calls[0]![0].data;
    expect(settingCallArgs.setup_config).toEqual(
      expect.objectContaining({
        defaultAgentId: 'agent-prebuilt-uuid',
        warrantyStartsOn: 'Invoice Sent',
        businessName: 'Apex Heating & Air',
      })
    );

    // 5. Job type warranty for primary job type has agent_id set to prebuilt agent
    const warranties = settingCallArgs.job_type_warranties as any[];
    const primaryRule = warranties.find((w) => w.job_type === 'HVAC Maintenance');
    expect(primaryRule).toBeDefined();
    expect(primaryRule.agent_id).toBe('agent-prebuilt-uuid');
    expect(primaryRule.phone_number).toBeNull();
  });

  it('does nothing if an agent already exists in the organization', async () => {
    vi.mocked(prisma.beeVoiceAgent.findFirst).mockResolvedValueOnce({
      id: 'existing-agent-123',
      organization_id: orgId,
      name: 'Custom Agent',
    } as any);

    await BeeService.seedDemoDataIfEmpty(orgId);

    expect(prisma.beeVoiceAgent.create).not.toHaveBeenCalled();
    expect(prisma.beeSetting.create).not.toHaveBeenCalled();
    expect(prisma.beeSetting.update).not.toHaveBeenCalled();
  });
});
