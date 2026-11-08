import { describe, it, expect, beforeEach, vi } from 'vitest';
import api from '@/lib/axios';
import { handleToolCall, commitAction, humanError, stripInternalIds } from '@/components/copilot/tools/toolHandlers';
import { prepareAction, type PreparedAction } from '@/components/copilot/tools/approval';

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleToolCall — reads', () => {
  it('query_crm jobs calls the API and summarizes', async () => {
    mockApi.get.mockResolvedValueOnce({
      data: { jobs: [{ job_number: 'J00049', status: 'SCHEDULED', customer: { first_name: 'John', last_name: 'Doe' } }], stats: { scheduled: 1 } },
    } as never);
    const out = await handleToolCall('query_crm', { resource: 'jobs' });
    expect(mockApi.get).toHaveBeenCalledWith('/api/jobs', expect.objectContaining({ params: expect.any(Object) }));
    expect(out.kind).toBe('immediate');
    if (out.kind === 'immediate') expect(out.output).toContain('J00049');
  });

  it('get_briefing calls the dashboard', async () => {
    mockApi.get.mockResolvedValueOnce({ data: { data: { kpis: { jobs_today: { total: 3, completed: 1, scheduled: 2 } }, needs_attention: [] } } } as never);
    const out = await handleToolCall('get_briefing', {});
    expect(mockApi.get).toHaveBeenCalledWith('/api/dashboard');
    expect(out.kind).toBe('immediate');
  });

  it('multi-word fallback keeps only records matching ALL words', async () => {
    const artNakamura = { id: 'c1', customer_number: 'C00001', first_name: 'Art', last_name: 'Nakamura', phone: '5550001111' };
    const artArt = { id: 'c2', customer_number: 'C00002', first_name: 'Art', last_name: 'Art', phone: '5550002222' };
    const bartlett = { id: 'c3', customer_number: 'C00003', first_name: 'Chase', last_name: 'Bartlett', phone: '5550003333' };
    // Full-string "Art Nakamura" matches nothing (first/last are separate fields)…
    mockApi.get.mockResolvedValueOnce({ data: { customers: [] } } as never);
    // …"Art" substring-matches three records, "Nakamura" matches one.
    mockApi.get.mockResolvedValueOnce({ data: { customers: [artNakamura, artArt, bartlett] } } as never);
    mockApi.get.mockResolvedValueOnce({ data: { customers: [artNakamura] } } as never);

    const out = await handleToolCall('query_crm', { resource: 'customers', query: 'Art Nakamura' });
    expect(out.kind).toBe('immediate');
    if (out.kind === 'immediate') {
      expect(out.output).toContain('Art Nakamura');
      expect(out.output).not.toContain('C00002');
      expect(out.output).not.toContain('Bartlett');
    }
  });

  it('multi-word fallback falls back to partial hits when nothing matches all words', async () => {
    const artArt = { id: 'c2', customer_number: 'C00002', first_name: 'Art', last_name: 'Art', phone: '5550002222' };
    mockApi.get.mockResolvedValueOnce({ data: { customers: [] } } as never); // full string
    mockApi.get.mockResolvedValueOnce({ data: { customers: [artArt] } } as never); // "Art"
    mockApi.get.mockResolvedValueOnce({ data: { customers: [] } } as never); // "Smith"
    const out = await handleToolCall('query_crm', { resource: 'customers', query: 'Ran Smith' });
    expect(out.kind).toBe('immediate');
    if (out.kind === 'immediate') expect(out.output).toContain('C00002');
  });
});

describe('stripInternalIds', () => {
  it('removes [id:…] and [location_id:…] markers, keeps everything else', () => {
    expect(stripInternalIds('Art Nakamura [id:528fd6fe-b13a] — 5550001111')).toBe('Art Nakamura — 5550001111');
    expect(stripInternalIds('Main St [location_id:abc-123], recent jobs: 2')).toBe('Main St, recent jobs: 2');
    expect(stripInternalIds('Scheduled [Jun 12] for J00042')).toBe('Scheduled [Jun 12] for J00042');
  });
});

describe('handleToolCall — conversational required-field collection', () => {
  it('create_lead without a customer asks instead of carding', async () => {
    const out = await handleToolCall('create_lead', { service_request: 'AC broken' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/customer_name/);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('create_lead with a resolved customer but no service_request asks for the work', async () => {
    mockApi.get.mockResolvedValueOnce({
      data: { customers: [{ id: 'c1', customer_number: 'C00001', first_name: 'Art', last_name: 'Nakamura' }] },
    } as never);
    const out = await handleToolCall('create_lead', { customer_name: 'Nakamura' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/work|service request/i);
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('estimate send without a deposit decision asks instead of carding', async () => {
    const out = await handleToolCall('update_estimate_status', { estimate_id: 'e1', action: 'send' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/deposit/i);
  });

  it('estimate send with deposit but no payment methods asks for methods', async () => {
    const out = await handleToolCall('update_estimate_status', { estimate_id: 'e1', action: 'send', deposit_required: true });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/payment methods/i);
  });

  it('estimate send with an explicit no-deposit decision cards as financial', async () => {
    const out = await handleToolCall('update_estimate_status', { estimate_id: 'e1', action: 'send', deposit_required: false });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') {
      expect(out.action.payload.deposit_required).toBe(false);
      expect(out.action.endpoint.path).toBe('/api/estimates/e1/send');
    }
  });

  it('estimate cancel without a reason asks instead of fabricating one', async () => {
    const out = await handleToolCall('update_estimate_status', { estimate_id: 'e1', action: 'cancel' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/reason/i);
  });

  it('job cancel without a reason asks instead of carding', async () => {
    const out = await handleToolCall('update_job_status', { job_id: 'j1', action: 'cancel' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/reason/i);
  });

  it('create_job without estimate or customer+location asks', async () => {
    const out = await handleToolCall('create_job', { customer_id: 'c1' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/service location/i);
  });

  it('create_customer without person-or-company name asks', async () => {
    const out = await handleToolCall('create_customer', { email: 'a@b.com', phone: '5551112222' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/name/i);
  });

  it('create_customer with neither phone nor email asks (SERV10X-35)', async () => {
    const out = await handleToolCall('create_customer', { first_name: 'Jane' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/phone number or an email/i);
  });

  it('create_customer with email only (no phone) cards without a blank Phone row (SERV10X-35)', async () => {
    const out = await handleToolCall('create_customer', { first_name: 'Jane', email: 'jane@example.com' });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') {
      expect(out.action.detail.some((d) => d.label === 'Phone')).toBe(false);
      expect(out.action.detail.some((d) => d.label === 'Email')).toBe(true);
    }
  });
});

describe('handleToolCall — create_lead resolves customer_name itself', () => {
  const artNakamura = { id: 'c1', customer_number: 'C00001', first_name: 'Art', last_name: 'Nakamura', phone: '5550001111' };
  const artArt = { id: 'c2', customer_number: 'C00002', first_name: 'Art', last_name: 'Art', phone: '5550002222' };

  it('exactly one match → cards with the resolved customer_id (no interrogation)', async () => {
    mockApi.get.mockResolvedValueOnce({ data: { customers: [artNakamura] } } as never);
    const out = await handleToolCall('create_lead', { customer_name: 'Nakamura', service_request: 'AC broken' });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') {
      expect(out.action.payload.customer_id).toBe('c1');
      expect(out.action.payload.customer_name).toBeUndefined();
      expect(out.action.summary).toContain('Art Nakamura (C00001)');
    }
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('uses the multi-word ranked search ("Art Nakamura" finds the right person)', async () => {
    mockApi.get.mockResolvedValueOnce({ data: { customers: [] } } as never); // full string
    mockApi.get.mockResolvedValueOnce({ data: { customers: [artNakamura, artArt] } } as never); // "Art"
    mockApi.get.mockResolvedValueOnce({ data: { customers: [artNakamura] } } as never); // "Nakamura"
    const out = await handleToolCall('create_lead', { customer_name: 'Art Nakamura', service_request: 'AC broken' });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') expect(out.action.payload.customer_id).toBe('c1');
  });

  it('multiple matches → lists them and asks which (with their ids for the re-call)', async () => {
    mockApi.get.mockResolvedValueOnce({ data: { customers: [artNakamura, artArt] } } as never);
    const out = await handleToolCall('create_lead', { customer_name: 'Art', service_request: 'AC broken' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.output).toContain('C00001');
      expect(out.output).toContain('C00002');
      expect(out.output).toMatch(/customer_id/);
    }
  });

  it('zero matches → asks whether this is a new customer, one question at a time', async () => {
    mockApi.get.mockResolvedValueOnce({ data: { customers: [] } } as never);
    const out = await handleToolCall('create_lead', { customer_name: 'Zed', service_request: 'AC broken' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/no existing customer/i);
  });

  it('an explicit customer_id wins — no lookup is made', async () => {
    const out = await handleToolCall('create_lead', { customer_id: 'c9', customer_name: 'Art Nakamura', service_request: 'AC broken' });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') expect(out.action.payload.customer_id).toBe('c9');
    expect(mockApi.get).not.toHaveBeenCalled();
  });
});

describe('handleToolCall — scheduling payload shape', () => {
  it('assign sends assignee_ids[] and preserves the current crew when omitted', async () => {
    mockApi.get.mockResolvedValueOnce({
      data: { job: { id: 'j1', assignees: [{ user: { id: 'u7', first_name: 'Mike' } }] } },
    } as never);
    const out = await handleToolCall('update_job_status', {
      job_id: 'j1',
      action: 'assign',
      scheduled_start: '2026-06-12T09:00:00-04:00',
      scheduled_end: '2026-06-12T11:00:00-04:00',
    });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') {
      expect(out.action.endpoint.path).toBe('/api/jobs/j1/assign');
      expect(out.action.payload.assignee_ids).toEqual(['u7']);
      expect(out.action.payload).not.toHaveProperty('assigned_to');
    }
  });

  it('reschedule_job goes through /assign with the current crew, not a bare PATCH', async () => {
    mockApi.get.mockResolvedValueOnce({
      data: { job: { id: 'j1', assignees: [{ user: { id: 'u7' } }, { user: { id: 'u8' } }] } },
    } as never);
    const out = await handleToolCall('reschedule_job', {
      job_id: 'j1',
      scheduled_start: '2026-06-13T09:00:00-04:00',
      scheduled_end: '2026-06-13T11:00:00-04:00',
    });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') {
      expect(out.action.endpoint.method).toBe('POST');
      expect(out.action.endpoint.path).toBe('/api/jobs/j1/assign');
      expect(out.action.payload.assignee_ids).toEqual(['u7', 'u8']);
    }
  });

  it('schedule_walkthrough without a time asks instead of carding', async () => {
    const out = await handleToolCall('schedule_walkthrough', { lead_id: 'l1', action: 'schedule' });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.output).toMatch(/date and time/i);
  });

  it('schedule_walkthrough cards the schedule payload with performer REPLACE semantics', async () => {
    const out = await handleToolCall('schedule_walkthrough', {
      lead_id: 'l1',
      action: 'schedule',
      walkthrough_scheduled_at: '2026-06-13T10:00:00-04:00',
      performer_ids: ['u7'],
      force: false,
    });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') {
      expect(out.action.endpoint.path).toBe('/api/leads/l1/walkthrough/schedule');
      expect(out.action.payload.performer_ids).toEqual(['u7']);
      expect(out.action.payload.walkthrough_scheduled_at).toBe('2026-06-13T10:00:00-04:00');
    }
  });

  it('schedule_walkthrough unschedule hits the unschedule endpoint with an empty payload', async () => {
    const out = await handleToolCall('schedule_walkthrough', { lead_id: 'l1', action: 'unschedule' });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') {
      expect(out.action.endpoint.path).toBe('/api/leads/l1/walkthrough/unschedule');
      expect(out.action.payload).toEqual({});
    }
  });

  it('create_lead with override:true pins the audited override path', async () => {
    const out = await handleToolCall('create_lead', {
      service_request: 'AC',
      customer_id: 'c1',
      override: true,
    });
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') {
      expect(out.action.endpoint.path).toBe('/api/leads?override=true');
      expect(out.action.summary).toMatch(/duplicate/i);
    }
  });
});

describe('handleToolCall — writes require approval (NO api call)', () => {
  it('create_lead returns an approval card and does not touch the API', async () => {
    const out = await handleToolCall('create_lead', {
      service_request: 'AC not cooling',
      new_customer: { first_name: 'Jane', last_name: 'Roe', email: 'j@x.com', phone: '5551234567', location: { address_line1: '1 St', city: 'Austin', state: 'TX', zip: '78701' } },
    });
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(out.kind).toBe('approval');
    if (out.kind === 'approval') {
      expect(out.action.endpoint.path).toBe('/api/leads');
      expect(out.action.hash).toBeTruthy();
    }
  });

  it('draft_message is immediate, never sends, and is labeled', async () => {
    const out = await handleToolCall('draft_message', { body: 'Hi, your tech is on the way.' });
    expect(out.kind).toBe('immediate');
    if (out.kind === 'immediate') {
      expect(out.label).toBe('draft_only_not_sent');
      expect(out.output).toMatch(/NOT SENT/i);
    }
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

describe('commitAction — executes only the pinned payload', () => {
  function leadAction(): PreparedAction {
    return prepareAction({
      capabilityId: 'create_lead',
      toolName: 'create_lead',
      summary: 'Create a lead',
      detail: [],
      endpoint: { method: 'POST', path: '/api/leads' },
      payload: { service_request: 'AC', customer_id: 'c1' },
    });
  }

  it('posts the payload and formats the result', async () => {
    mockApi.post.mockResolvedValueOnce({ data: { lead: { lead_number: 'L00042' } } } as never);
    const res = await commitAction(leadAction());
    expect(mockApi.post).toHaveBeenCalledWith('/api/leads', { service_request: 'AC', customer_id: 'c1' });
    expect(res).toEqual({ ok: true, resultText: 'Created lead L00042' });
  });

  it('aborts if the payload drifted after approval (no API call)', async () => {
    const action = leadAction();
    action.payload.customer_id = 'TAMPERED';
    const res = await commitAction(action);
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it('NEVER auto-retries a 409 — relays the duplicate match and the override path instead', async () => {
    mockApi.post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { error: 'duplicate', existing: { id: 'c9', customer_number: 'C00012', first_name: 'Art', last_name: 'Nakamura', email: 'r@x.com', is_active: true } },
      },
    });
    const res = await commitAction(leadAction());
    expect(mockApi.post).toHaveBeenCalledTimes(1); // no silent override
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('C00012');
      expect(res.error).toContain('override:true');
      expect(res.error).toContain('[id:c9]');
    }
  });

  it('renders schedule conflicts from an assign 409 with force guidance', async () => {
    mockApi.post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { error: 'Schedule conflict detected', conflicts: [{ type: 'job', number: 'J00007', start: '2026-06-12T09:00:00Z', end: '2026-06-12T11:00:00Z' }] },
      },
    });
    const res = await commitAction(
      prepareAction({
        capabilityId: 'update_job_status',
        toolName: 'update_job_status',
        summary: 's',
        detail: [],
        endpoint: { method: 'POST', path: '/api/jobs/j1/assign' },
        payload: { assignee_ids: ['u1'], scheduled_start: 'x', scheduled_end: 'y' },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('J00007');
      expect(res.error).toContain('force:true');
    }
  });

  it('maps API errors to friendly text', async () => {
    mockApi.post.mockRejectedValueOnce({ response: { status: 403 } });
    const res = await commitAction(
      prepareAction({
        capabilityId: 'create_estimate',
        toolName: 'create_estimate',
        summary: 's',
        detail: [],
        endpoint: { method: 'POST', path: '/api/estimates' },
        payload: { lead_id: 'l1', line_items: [] },
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/permission/i);
  });
});

describe('humanError', () => {
  it('maps common statuses', () => {
    expect(humanError({ response: { status: 403 } })).toMatch(/permission/i);
    expect(humanError({ response: { status: 404 } })).toMatch(/find/i);
    expect(humanError({ response: { status: 400, data: { details: [{ message: 'bad field' }] } } })).toMatch(/bad field/i);
  });
});
