import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, ESTIMATE_FIXTURE } from './helpers';

vi.mock('../services/copilot/brain', () => ({
  generateReply: vi.fn(),
  isBrainNotConfigured: vi.fn(),
}));

import { generateReply, isBrainNotConfigured } from '../services/copilot/brain';

const mockGenerateReply = vi.mocked(generateReply);
const mockIsBrainNotConfigured = vi.mocked(isBrainNotConfigured);

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBrainNotConfigured.mockReturnValue(false);
});

describe('POST /api/estimates/:id/ai/draft-scope', () => {
  it('drafts a scope paragraph from the estimate line items', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      line_items: [{ description: 'Replace condenser unit', quantity: 1 }],
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockGenerateReply.mockResolvedValue({ text: 'We will replace the condenser unit.', functionCalls: [] });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/ai/draft-scope`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.scope_text).toBe('We will replace the condenser unit.');
    const callArgs = mockGenerateReply.mock.calls[0][0] as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(callArgs.contents[0].parts[0].text).toContain('Replace condenser unit');
  });

  it('rejects when the estimate has no line items yet', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      line_items: [],
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/ai/draft-scope`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('returns 503 when the AI provider is not configured — never a fake success', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      line_items: [{ description: 'Replace condenser unit', quantity: 1 }],
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockGenerateReply.mockRejectedValue(new Error('no key'));
    mockIsBrainNotConfigured.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/ai/draft-scope`)
      .set(authHeader('admin'));

    expect(res.status).toBe(503);
  });

  it('returns 404 for a non-existent estimate', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/estimates/nonexistent/ai/draft-scope')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('SALES cannot draft a scope for another rep\'s estimate (403)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      line_items: [{ description: 'Replace condenser unit', quantity: 1 }],
      lead: { lead_assignees: [{ user_id: TEST_USERS.admin.id }] },
    });

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/ai/draft-scope`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});
