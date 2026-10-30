import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as any;

// Email.id, MessageThread.id and WhatsAppChat.id are Postgres `uuid` columns. A malformed `:id` on a communication route (a
// hand-typed URL, a truncated link, a client placeholder) reached Prisma's `where: { id }`, the driver threw P2023 and the
// handler's catch answered 500 'Internal server error'. Found on staging in the final scenario pass:
//
//   GET /api/communication/emails/unmatched/not-a-uuid   ->  500   (a well-formed unknown id answers 404 'Email not found')
//
// A client mistake is not a server fault, and it must be indistinguishable from a row that is not there. Every `:id` route that
// shares the defect is covered here; `requireUuidParam` answers each with the 404 its handler already uses for a miss, before
// Prisma is touched.

const MALFORMED = 'not-a-uuid';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('email :id routes - a malformed id is a 404, never a 500', () => {
  it('GET /emails/unmatched/:id answers 404 Email not found', async () => {
    mockAuthAs('admin');

    const res = await request(app).get(`/api/communication/emails/unmatched/${MALFORMED}`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Email not found');
    expect(mockPrisma.email.findFirst).not.toHaveBeenCalled();
  });

  it('GET /emails/:id answers 404 Email not found', async () => {
    mockAuthAs('admin');

    const res = await request(app).get(`/api/communication/emails/${MALFORMED}`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Email not found');
    expect(mockPrisma.email.findFirst).not.toHaveBeenCalled();
  });

  it('GET /emails/:id/attachments/:index answers 404', async () => {
    mockAuthAs('admin');

    const res = await request(app).get(`/api/communication/emails/${MALFORMED}/attachments/0`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(mockPrisma.email.findFirst).not.toHaveBeenCalled();
  });

  it('PATCH /emails/:id/link answers 404 Email not found', async () => {
    mockAuthAs('admin');

    const res = await request(app).patch(`/api/communication/emails/${MALFORMED}/link`).send({}).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Email not found');
    expect(mockPrisma.email.findFirst).not.toHaveBeenCalled();
  });

  it('PATCH /emails/:id/job and /lead answer 404 Email not found', async () => {
    mockAuthAs('admin');

    const job = await request(app).patch(`/api/communication/emails/${MALFORMED}/job`).send({ job_id: null }).set(authHeader('admin'));
    const lead = await request(app).patch(`/api/communication/emails/${MALFORMED}/lead`).send({ lead_id: null }).set(authHeader('admin'));

    expect(job.status).toBe(404);
    expect(lead.status).toBe(404);
    expect(mockPrisma.email.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.email.updateMany).not.toHaveBeenCalled();
  });

  it('GET /emails/:id/customer-candidates and PATCH /emails/:id/customer answer 404', async () => {
    mockAuthAs('admin');

    const candidates = await request(app).get(`/api/communication/emails/${MALFORMED}/customer-candidates`).set(authHeader('admin'));
    const pick = await request(app)
      .patch(`/api/communication/emails/${MALFORMED}/customer`)
      .send({ customer_id: '00000000-0000-4000-8000-000000000000' })
      .set(authHeader('admin'));

    expect(candidates.status).toBe(404);
    expect(pick.status).toBe(404);
  });
});

describe('text and chat :id routes - a malformed id is a 404, never a 500', () => {
  it('GET /threads/:id answers 404 Thread not found', async () => {
    mockAuthAs('admin');

    const res = await request(app).get(`/api/communication/threads/${MALFORMED}`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Thread not found');
    expect(mockPrisma.messageThread.findFirst).not.toHaveBeenCalled();
  });

  it('GET /whatsapp/:id answers 404 Chat not found', async () => {
    mockAuthAs('admin', { is_demo: true });

    const res = await request(app).get(`/api/communication/whatsapp/${MALFORMED}`).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Chat not found');
    expect(mockPrisma.whatsAppChat.findFirst).not.toHaveBeenCalled();
  });
});
