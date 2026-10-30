/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.1 - the Job Type and Job Source lists fill for everyone.

   The job form, the lead form and the Leads list filters read both lists from the company record
   (GET /api/organization). This suite reads it as a person on a custom role holding the Technician
   preset's switch values, in the two shapes a company's roles come in: a role copied from the preset
   (it carries stored grants) and one whose stored grants lack any company read - the shape that left
   the lists empty before. Real migrated database (TEST_DATABASE_URL); the suite skips when it is
   unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { presetSwitchSet } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('Job type and job source lists answer a person with the Technician preset values (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });

  let sequence = 0;

  /** A person on a custom role copied from the Technician preset; `withoutCompanyRead` strips the stored company read. */
  async function technicianPreset(org: string, opts: { withoutCompanyRead: boolean }) {
    const key = `tech-preset-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    if (opts.withoutCompanyRead) {
      await db.rolePermission.deleteMany({ where: { organization_id: org, role: key, subject: 'Organization' } });
    }
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: presetSwitchSet('TECHNICIAN'), actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `tech${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
    return fx.signedInAs(person);
  }

  for (const withoutCompanyRead of [false, true]) {
    it(`lists both company lists${withoutCompanyRead ? ' when the role holds no stored company read' : ''}`, async () => {
      const { org } = await fx.newOrg();
      await db.organization.update({
        where: { id: org },
        data: { job_type_options: ['Install', 'Repair'], source_options: ['Referral', 'Website'] },
      });
      const api = await technicianPreset(org, { withoutCompanyRead });

      const res = await api.get('/api/organization');

      expect(res.status).toBe(200);
      expect(res.body.job_type_options).toEqual(['Install', 'Repair']);
      expect(res.body.source_options).toEqual(['Referral', 'Website']);
    });
  }

  it('still refuses that person a change to the lists: editing them is Company settings', async () => {
    const { org } = await fx.newOrg();
    const api = await technicianPreset(org, { withoutCompanyRead: false });

    const res = await api.patch('/api/organization', { job_type_options: ['Sneaky'] });

    expect(res.status).toBe(403);
    const row = await db.organization.findUnique({ where: { id: org }, select: { job_type_options: true } });
    expect(row?.job_type_options).not.toContain('Sneaky');
  });
});
