import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';
import { prisma } from '../lib/prisma';

// ─── Fixtures ────────────────────────────────────────

const MOCK_PREF = {
  user_id: TEST_USERS.admin.id,
  table_key: 'customers',
  config: {
    version: 1,
    columns: {
      name: { width: 200, visible: true },
      phone: { visible: false },
    },
  },
  updated_at: new Date('2026-01-01'),
};

// ─── GET /api/me/table-views/:tableKey ───────────────

describe('GET /api/me/table-views/:tableKey', () => {
  beforeEach(() => {
    mockAuthAs('admin');
  });

  it('returns {} when no saved view exists', async () => {
    (prisma.userTablePreference.findFirst as any).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/me/table-views/customers')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('returns saved config when a preference exists', async () => {
    (prisma.userTablePreference.findFirst as any).mockResolvedValue(MOCK_PREF);

    const res = await request(app)
      .get('/api/me/table-views/customers')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_PREF.config);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/me/table-views/customers');
    expect(res.status).toBe(401);
  });

  it('returns 400 for table_key not in allowlist', async () => {
    const res = await request(app)
      .get('/api/me/table-views/widgets')
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid table key/i);
  });

  it('returns 400 for all unknown table keys', async () => {
    for (const badKey of ['users', 'payments', 'foo', '']) {
      if (badKey === '') continue; // empty string would be a different route
      const res = await request(app)
        .get(`/api/me/table-views/${badKey}`)
        .set(authHeader('admin'));
      expect(res.status).toBe(400);
    }
  });

  it('accepts all valid table keys', async () => {
    (prisma.userTablePreference.findFirst as any).mockResolvedValue(null);

    for (const key of ['customers', 'leads', 'estimates', 'jobs', 'invoices']) {
      const res = await request(app)
        .get(`/api/me/table-views/${key}`)
        .set(authHeader('admin'));
      expect(res.status).toBe(200);
    }
  });

  it('user B GET returns {} even when user A saved config (user isolation)', async () => {
    // user A (admin) saves a pref
    // user B (sales) queries the same key — should get nothing
    mockAuthAs('sales');

    // findFirst is called with user_id filter — mock returns null for sales user
    (prisma.userTablePreference.findFirst as any).mockImplementation(
      (args: { where: { user_id: string; table_key: string } }) => {
        if (args.where.user_id === TEST_USERS.admin.id) {
          return Promise.resolve(MOCK_PREF);
        }
        return Promise.resolve(null);
      }
    );

    const res = await request(app)
      .get('/api/me/table-views/customers')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});

    // Confirm the query included sales user's id, not admin's
    const calls = (prisma.userTablePreference.findFirst as any).mock.calls;
    const callArgs = calls.at(-1)[0];
    expect(callArgs.where.user_id).toBe(TEST_USERS.sales.id);
  });
});

// ─── PUT /api/me/table-views/:tableKey ───────────────

describe('PUT /api/me/table-views/:tableKey', () => {
  const VALID_CONFIG = {
    version: 1,
    columns: {
      name: { width: 200, visible: true },
      phone: { visible: false },
    },
  };

  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.userTablePreference.upsert as any).mockImplementation(
      ({ create }: any) => Promise.resolve({ ...MOCK_PREF, config: create.config })
    );
  });

  it('upserts and returns the saved config', async () => {
    const res = await request(app)
      .put('/api/me/table-views/customers')
      .set(authHeader('admin'))
      .send(VALID_CONFIG);

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.columns.name.width).toBe(200);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .put('/api/me/table-views/customers')
      .send(VALID_CONFIG);
    expect(res.status).toBe(401);
  });

  it('returns 400 for table_key not in allowlist', async () => {
    const res = await request(app)
      .put('/api/me/table-views/widgets')
      .set(authHeader('admin'))
      .send(VALID_CONFIG);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid table key/i);
  });

  it('returns 400 when version is missing', async () => {
    const res = await request(app)
      .put('/api/me/table-views/customers')
      .set(authHeader('admin'))
      .send({ columns: {} });

    expect(res.status).toBe(400);
  });

  it('returns 400 when version is not an integer', async () => {
    const res = await request(app)
      .put('/api/me/table-views/customers')
      .set(authHeader('admin'))
      .send({ version: 1.5, columns: {} });

    expect(res.status).toBe(400);
  });

  it('returns 400 when columns is missing', async () => {
    const res = await request(app)
      .put('/api/me/table-views/customers')
      .set(authHeader('admin'))
      .send({ version: 1 });

    expect(res.status).toBe(400);
  });

  it('clamps width values below 64 to 64', async () => {
    const res = await request(app)
      .put('/api/me/table-views/customers')
      .set(authHeader('admin'))
      .send({ version: 1, columns: { name: { width: 10 } } });

    expect(res.status).toBe(200);
    const savedConfig = (prisma.userTablePreference.upsert as any).mock.calls.at(-1)[0].create.config;
    expect(savedConfig.columns.name.width).toBe(64);
  });

  it('clamps width values above 1200 to 1200', async () => {
    const res = await request(app)
      .put('/api/me/table-views/customers')
      .set(authHeader('admin'))
      .send({ version: 1, columns: { name: { width: 9999 } } });

    expect(res.status).toBe(200);
    const savedConfig = (prisma.userTablePreference.upsert as any).mock.calls.at(-1)[0].create.config;
    expect(savedConfig.columns.name.width).toBe(1200);
  });

  it('passes through width in range [64, 1200] unchanged', async () => {
    const res = await request(app)
      .put('/api/me/table-views/customers')
      .set(authHeader('admin'))
      .send({ version: 1, columns: { name: { width: 300 } } });

    expect(res.status).toBe(200);
    const savedConfig = (prisma.userTablePreference.upsert as any).mock.calls.at(-1)[0].create.config;
    expect(savedConfig.columns.name.width).toBe(300);
  });

  it('passes through columns without width unchanged', async () => {
    const res = await request(app)
      .put('/api/me/table-views/customers')
      .set(authHeader('admin'))
      .send({ version: 1, columns: { name: { visible: true } } });

    expect(res.status).toBe(200);
    const savedConfig = (prisma.userTablePreference.upsert as any).mock.calls.at(-1)[0].create.config;
    expect(savedConfig.columns.name.width).toBeUndefined();
    expect(savedConfig.columns.name.visible).toBe(true);
  });

  it('scopes upsert to the authenticated user id', async () => {
    await request(app)
      .put('/api/me/table-views/leads')
      .set(authHeader('admin'))
      .send(VALID_CONFIG);

    const upsertArgs = (prisma.userTablePreference.upsert as any).mock.calls.at(-1)[0];
    expect(upsertArgs.where.user_id_table_key.user_id).toBe(TEST_USERS.admin.id);
    expect(upsertArgs.where.user_id_table_key.table_key).toBe('leads');
    expect(upsertArgs.create.user_id).toBe(TEST_USERS.admin.id);
  });
});

// ─── GET after PUT round-trip ─────────────────────────

describe('GET after PUT returns saved config', () => {
  it('returns exactly what was PUT', async () => {
    mockAuthAs('admin');

    const config = {
      version: 2,
      columns: {
        name: { width: 250, visible: true, manuallySized: true },
        status: { visible: false },
      },
    };

    const savedPref = {
      user_id: TEST_USERS.admin.id,
      table_key: 'leads',
      config,
      updated_at: new Date(),
    };

    (prisma.userTablePreference.upsert as any).mockResolvedValue(savedPref);
    (prisma.userTablePreference.findFirst as any).mockResolvedValue(savedPref);

    const putRes = await request(app)
      .put('/api/me/table-views/leads')
      .set(authHeader('admin'))
      .send(config);

    expect(putRes.status).toBe(200);

    const getRes = await request(app)
      .get('/api/me/table-views/leads')
      .set(authHeader('admin'));

    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual(config);
  });
});
