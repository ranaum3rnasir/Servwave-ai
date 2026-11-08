import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';

vi.mock('../lib/email', () => ({
  sendAiFarmBookingEmails: vi.fn().mockResolvedValue(undefined),
}));
import { sendAiFarmBookingEmails } from '../lib/email';
const mockSendBookingEmails = sendAiFarmBookingEmails as ReturnType<typeof vi.fn>;

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn> };
};

const VALID_BODY = {
  agentName: 'Carlos',
  agentRole: 'Invoice Auditor',
  day: 'Mon, Jan 5',
  slot: '10:30 AM',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSendBookingEmails.mockResolvedValue(undefined);
  mockPrisma.organization.findUnique.mockResolvedValue({ name: 'Doe HVAC' });
});

describe('POST /api/ai-farm/bookings', () => {
  it('sends the booking emails and returns ok for an authenticated user', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .post('/api/ai-farm/bookings')
      .set(authHeader('sales'))
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSendBookingEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterName: 'Test Sales',
        requesterEmail: 'sales@test.com',
        orgName: 'Doe HVAC',
        agentName: 'Carlos',
        agentRole: 'Invoice Auditor',
        day: 'Mon, Jan 5',
        slot: '10:30 AM',
      })
    );
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/ai-farm/bookings').send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockSendBookingEmails).not.toHaveBeenCalled();
  });

  it('rejects a request missing required fields', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/ai-farm/bookings')
      .set(authHeader('admin'))
      .send({ agentName: 'Carlos' });

    expect(res.status).toBe(400);
    expect(mockSendBookingEmails).not.toHaveBeenCalled();
  });

  it('returns 502 when the email send fails, so the UI never shows a false confirmation', async () => {
    mockAuthAs('admin');
    mockSendBookingEmails.mockRejectedValueOnce(new Error('Resend down'));
    const res = await request(app)
      .post('/api/ai-farm/bookings')
      .set(authHeader('admin'))
      .send(VALID_BODY);

    expect(res.status).toBe(502);
    expect(res.body.error).toBeTruthy();
  });

  it('is not scoped to a specific role — any authenticated org member can book', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post('/api/ai-farm/bookings')
      .set(authHeader('technician'))
      .send(VALID_BODY);

    expect(res.status).toBe(200);
  });
});
