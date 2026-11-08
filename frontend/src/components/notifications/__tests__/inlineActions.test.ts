/**
 * Tests for inlineActions.ts
 *
 * Verifies the action_type → handler mapping and the critical
 * "stamp acted only on success, not on failure" contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationView } from '@/lib/api/notifications';
import { ACTION_HANDLERS } from '../inlineActions';

// ---------------------------------------------------------------------------
// Mock api
// ---------------------------------------------------------------------------

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

import api from '@/lib/axios';

// ---------------------------------------------------------------------------
// Mock navigate (react-router-dom)
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<NotificationView>): NotificationView {
  return {
    id: 'notif-1',
    verb: 'created',
    category: 'TEAM',
    priority: 'INTERRUPT',
    needs_action: true,
    title: 'Test',
    body: null,
    object_type: 'TIME_ENTRY',
    object_id: 'obj-1',
    object_label: null,
    action_type: null,
    data: {},
    created_at: '2026-06-17T10:00:00Z',
    seen_at: null,
    read_at: null,
    acted_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ACTION_HANDLERS map', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('all expected action_types are registered', () => {
    const expected = [
      'SCHEDULE_JOB',
      'APPROVE_OT',
      'DENY_OT',
      'APPROVE_STOCK',
      'DENY_STOCK',
      'SEND_REMINDER',
      'VIEW',
    ];
    for (const key of expected) {
      expect(ACTION_HANDLERS[key], `missing handler for ${key}`).toBeDefined();
    }
  });

  it('APPROVE_OT calls POST /api/timeclock/punches/:id/override/approve', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: {} });
    const item = makeItem({ action_type: 'APPROVE_OT', data: { punch_id: 'punch-abc' } });
    await ACTION_HANDLERS.APPROVE_OT!(item, mockNavigate);
    expect(api.post).toHaveBeenCalledWith('/api/timeclock/punches/punch-abc/override/approve');
  });

  it('DENY_OT calls POST /api/timeclock/punches/:id/override/reject', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: {} });
    const item = makeItem({ action_type: 'DENY_OT', data: { punch_id: 'punch-abc' } });
    await ACTION_HANDLERS.DENY_OT!(item, mockNavigate);
    expect(api.post).toHaveBeenCalledWith('/api/timeclock/punches/punch-abc/override/reject');
  });

  it('APPROVE_STOCK calls decide with decision=approved', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: {} });
    const item = makeItem({ action_type: 'APPROVE_STOCK', data: { approval_id: 'appr-1' } });
    await ACTION_HANDLERS.APPROVE_STOCK!(item, mockNavigate);
    expect(api.post).toHaveBeenCalledWith('/api/inventory/stock-approvals/decide', {
      id: 'appr-1',
      decision: 'approved',
    });
  });

  it('DENY_STOCK calls decide with decision=rejected', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: {} });
    const item = makeItem({ action_type: 'DENY_STOCK', data: { approval_id: 'appr-1' } });
    await ACTION_HANDLERS.DENY_STOCK!(item, mockNavigate);
    expect(api.post).toHaveBeenCalledWith('/api/inventory/stock-approvals/decide', {
      id: 'appr-1',
      decision: 'rejected',
    });
  });

  it('SEND_REMINDER calls POST /api/invoices/:id/resend (legacy payload: invoice_id in data)', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: {} });
    const item = makeItem({ action_type: 'SEND_REMINDER', data: { invoice_id: 'inv-99' } });
    await ACTION_HANDLERS.SEND_REMINDER!(item, mockNavigate);
    expect(api.post).toHaveBeenCalledWith('/api/invoices/inv-99/resend', {});
  });

  // Realistic BE payload: object: {type:'INVOICE', id: <id>}, data: { due_date, object_label }
  // — no invoice_id in data; handler must fall back to object_id
  it('SEND_REMINDER uses object_id when data has no invoice_id (real BE payload)', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: {} });
    const item = makeItem({
      action_type: 'SEND_REMINDER',
      object_type: 'INVOICE',
      object_id: 'inv-real-123',
      data: { due_date: '2026-07-01', object_label: 'INV I00042' },
    });
    await ACTION_HANDLERS.SEND_REMINDER!(item, mockNavigate);
    expect(api.post).toHaveBeenCalledWith('/api/invoices/inv-real-123/resend', {});
  });

  it('SCHEDULE_JOB navigates to /estimates/:estimate_id (legacy payload: estimate_id in data)', async () => {
    const item = makeItem({ action_type: 'SCHEDULE_JOB', data: { estimate_id: 'est-77' } });
    await ACTION_HANDLERS.SCHEDULE_JOB!(item, mockNavigate);
    expect(mockNavigate).toHaveBeenCalledWith('/estimates/est-77');
    expect(api.post).not.toHaveBeenCalled();
  });

  // Realistic BE payload: object: {type:'ESTIMATE', id: <id>}, data: { object_label }
  // — no estimate_id in data; handler must fall back to object_id
  it('SCHEDULE_JOB uses object_id when data has no estimate_id (real BE payload)', async () => {
    const item = makeItem({
      action_type: 'SCHEDULE_JOB',
      object_type: 'ESTIMATE',
      object_id: 'est-real-456',
      data: { object_label: 'E00077' },
    });
    await ACTION_HANDLERS.SCHEDULE_JOB!(item, mockNavigate);
    expect(mockNavigate).toHaveBeenCalledWith('/estimates/est-real-456');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('SCHEDULE_JOB falls back to /jobs?action=new-job when no estimate_id and no object_id', async () => {
    const item = makeItem({ action_type: 'SCHEDULE_JOB', object_id: '', data: {} });
    await ACTION_HANDLERS.SCHEDULE_JOB!(item, mockNavigate);
    expect(mockNavigate).toHaveBeenCalledWith('/jobs?action=new-job');
  });

  it('SCHEDULE_JOB navigates to the lead with the createJob param when data.lead_id is present', async () => {
    const navigate = vi.fn();
    const item = makeItem({ action_type: 'SCHEDULE_JOB', object_id: 'est-9', data: { lead_id: 'lead-5' } });
    const result = await ACTION_HANDLERS.SCHEDULE_JOB!(item, navigate);
    expect(navigate).toHaveBeenCalledWith('/leads/lead-5?createJob=est-9');
    expect(result).toEqual({ skipActed: true });
  });

  it('SCHEDULE_JOB falls back to the estimate page for legacy payloads without lead_id', async () => {
    const navigate = vi.fn();
    const item = makeItem({ action_type: 'SCHEDULE_JOB', object_id: 'est-9', data: {} });
    const result = await ACTION_HANDLERS.SCHEDULE_JOB!(item, navigate);
    expect(navigate).toHaveBeenCalledWith('/estimates/est-9');
    expect(result).toEqual({ skipActed: true });
  });

  it('VIEW navigates via notificationDeepLink (no API call)', async () => {
    const item = makeItem({
      action_type: 'VIEW',
      object_type: 'JOB',
      object_id: 'job-42',
    });
    await ACTION_HANDLERS.VIEW!(item, mockNavigate);
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-42');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a failing handler throws (caller must not stamp acted)', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('network error'));
    const item = makeItem({ action_type: 'APPROVE_OT', data: { punch_id: 'punch-x' } });
    await expect(ACTION_HANDLERS.APPROVE_OT!(item, mockNavigate)).rejects.toThrow('network error');
  });
});
