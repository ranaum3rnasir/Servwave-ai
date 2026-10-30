/* =============================================================================
   Roles & Permissions AL-16 (ticket 24): a new company has an Owner from the start.

   The e2e company is made the way a real company is: the company, then the person it is set up for, who becomes its Owner in
   the same write. Its teardown still removes it whole: the purge lets go of the Owner before it deletes the people (the
   database refuses to delete the Owner's row otherwise).

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Only the auth provider is replaced.
   ========================================================================== */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('a new company has an Owner (real database)', () => {
  const db = realClient as PrismaClient;

  beforeAll(async () => {
    // The e2e provisioning refuses any database it is not pointed at explicitly: point it at this test database.
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const { env } = await import('../config/env.js');
    Object.assign(env, {
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      E2E_ALLOWED_DB_HOSTS: url.hostname,
      E2E_ALLOWED_DB_REF: url.pathname.slice(1),
    });
  });

  it('the e2e company: its admin is its Owner, and its teardown still removes it', async () => {
    const authAdmin = supabaseAdmin.auth.admin as unknown as { createUser: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> };
    authAdmin.createUser.mockResolvedValue({ data: { user: { id: randomUUID() } }, error: null });
    authAdmin.deleteUser.mockResolvedValue({ data: null, error: null });
    const { provisionTestOrg, teardownTestOrg } = await import('../lib/e2e-org.js');

    const made = await provisionTestOrg();
    try {
      const company = await db.organization.findUniqueOrThrow({ where: { id: made.organizationId }, select: { owner_user_id: true } });
      expect(company.owner_user_id).toBe(made.adminUserId);
    } finally {
      await teardownTestOrg(made.organizationId, { authSweep: 'org' });
    }
    expect(await db.organization.count({ where: { id: made.organizationId } })).toBe(0);
    expect(await db.user.count({ where: { organization_id: made.organizationId } })).toBe(0);
  }, 120_000);
});
