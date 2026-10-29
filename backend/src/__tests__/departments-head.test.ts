import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';

const mockPrisma = prisma as unknown as {
  department: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  user: { findFirst: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
});

const DEPT_ID = 'dddddddd-0000-0000-0000-000000000001';

describe('PATCH /api/departments/:id — display-only head_id', () => {
  it('sets head_id when the head belongs to the org', async () => {
    mockAuthAs('admin');
    mockPrisma.department.findFirst.mockResolvedValueOnce({ id: DEPT_ID, name: 'HVAC' });
    mockPrisma.user.findFirst.mockResolvedValue({ id: TEST_USERS.technician.id });
    mockPrisma.department.update.mockResolvedValue({
      id: DEPT_ID, name: 'HVAC', head_id: TEST_USERS.technician.id,
      head: { id: TEST_USERS.technician.id, first_name: 'Test', last_name: 'Tech' }, created_at: new Date(),
    });

    const res = await request(app)
      .patch(`/api/departments/${DEPT_ID}`).set(authHeader('admin'))
      .send({ head_id: TEST_USERS.technician.id });

    expect(res.status).toBe(200);
    expect(mockPrisma.department.update.mock.calls[0][0].data).toMatchObject({ head_id: TEST_USERS.technician.id });
  });

  it('clears head_id with null', async () => {
    mockAuthAs('admin');
    mockPrisma.department.findFirst.mockResolvedValueOnce({ id: DEPT_ID, name: 'HVAC' });
    mockPrisma.department.update.mockResolvedValue({ id: DEPT_ID, name: 'HVAC', head_id: null, head: null, created_at: new Date() });

    const res = await request(app)
      .patch(`/api/departments/${DEPT_ID}`).set(authHeader('admin')).send({ head_id: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.department.update.mock.calls[0][0].data).toMatchObject({ head_id: null });
  });

  it('400 when the head user is not in the org', async () => {
    mockAuthAs('admin');
    mockPrisma.department.findFirst.mockResolvedValueOnce({ id: DEPT_ID, name: 'HVAC' });
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/departments/${DEPT_ID}`).set(authHeader('admin'))
      .send({ head_id: '00000000-0000-0000-0000-0000000000ab' });

    expect(res.status).toBe(400);
    expect(mockPrisma.department.update).not.toHaveBeenCalled();
  });

  it('still renames without touching head', async () => {
    mockAuthAs('admin');
    mockPrisma.department.findFirst.mockResolvedValueOnce({ id: DEPT_ID, name: 'Old' });
    mockPrisma.department.findFirst.mockResolvedValueOnce(null); // no name collision
    mockPrisma.department.update.mockResolvedValue({ id: DEPT_ID, name: 'New', head_id: null, head: null, created_at: new Date() });

    const res = await request(app)
      .patch(`/api/departments/${DEPT_ID}`).set(authHeader('admin')).send({ name: 'New' });

    expect(res.status).toBe(200);
    expect(mockPrisma.department.update.mock.calls[0][0].data).toMatchObject({ name: 'New' });
  });

  it('requires user-management permission (dispatcher 403)', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .patch(`/api/departments/${DEPT_ID}`).set(authHeader('dispatcher')).send({ head_id: null });
    expect(res.status).toBe(403);
  });
});
