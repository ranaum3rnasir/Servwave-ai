/**
 * #2030 slice 2 — a version is minted at every event where a customer RECEIVES the document.
 *
 * Sending, marking as sent manually (delivered outside the system), and copying to an invoice
 * (which is what makes a payment reconcilable against what was quoted). Only sending did.
 *
 * The three POSITIVE cases live in estimates.test.ts, alongside the harnesses those endpoints
 * already have. What lives here is the NEGATIVE one — an ordinary edit mints nothing, because
 * editing is not a delivery — which needs no harness and which "we only call it in three places"
 * is not enough to guarantee against a future change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, TEST_USERS, ESTIMATE_FIXTURE } from './helpers';

vi.mock('../lib/mint-estimate-version', () => ({
  VERSION_TRIGGERS: ['SEND', 'MARK_SENT', 'COPY_TO_INVOICE'],
  mintEstimateVersion: vi.fn().mockResolvedValue(undefined),
}));

import { mintEstimateVersion } from '../lib/mint-estimate-version';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimateLineItem: { findMany: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
});

describe('an ordinary edit', () => {
  it('mints nothing — editing is not a delivery', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: ESTIMATE_FIXTURE.id,
      status: 'DRAFT',
      tax_rate: 0.0625,
      discount_type: null,
      discount_value: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
    });
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(ESTIMATE_FIXTURE);

    await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ scope_notes: 'A tweak.' })
      .expect(200);

    expect(mintEstimateVersion).not.toHaveBeenCalled();
  });
});
