/**
 * Calendar Entries (Slice 01) — the `CalendarEntry` permission subject, seeded into every
 * existing org.
 *
 * This slice ships permission plumbing AHEAD of the capability it gates (no `calendar_entries`
 * table exists yet — Slice 02). Precedent: 20260819230000_editable_record_ids_dispatcher_backfill
 * did the same for DISPATCHER `renumber`. Doing so here means §9 risk 2 — "the per-org grant
 * backfill is the most likely thing to ship broken and be invisible in testing, because the
 * developer's own org will have the grant" — can be reviewed as the only thing in the diff.
 *
 * Modelled on permissions-technician-pricebook-backfill.test.ts /
 * permissions-editable-record-ids-backfill.test.ts: pin the migration SQL to DEFAULT_GRANTS (the
 * canonical grant set is the code), then drive the REAL production functions
 * (isCatalogEntry / viewModelToGrants / putRolePermissions / defineAbilityFor) rather than
 * asserting on a literal — see "THE GATE" in catalog.ts for why an isCatalogEntry-only assertion
 * is a placebo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import app from '../app';
import { prisma } from '../lib/prisma';
import { PERMISSION_CATALOG, isCatalogEntry } from '../lib/permissions/catalog';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { MODULES } from '../lib/permissions/roleViewModel';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

describe('PERMISSION_CATALOG — CalendarEntry subject', () => {
  it('holds exactly four CalendarEntry rows (read/create/update/delete), category Calendar', () => {
    const rows = PERMISSION_CATALOG.filter((e) => e.subject === 'CalendarEntry');
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'delete', 'read', 'update']);
    for (const r of rows) expect(r.category).toBe('Calendar');
  });

  it('isCatalogEntry recognizes all four CalendarEntry actions', () => {
    expect(isCatalogEntry('read', 'CalendarEntry')).toBe(true);
    expect(isCatalogEntry('create', 'CalendarEntry')).toBe(true);
    expect(isCatalogEntry('update', 'CalendarEntry')).toBe(true);
    expect(isCatalogEntry('delete', 'CalendarEntry')).toBe(true);
  });
});

describe('DEFAULT_GRANTS — CalendarEntry subject', () => {
  it('holds exactly four rows, all role DISPATCHER, all unconditional', () => {
    const rows = DEFAULT_GRANTS.filter((g) => g.subject === 'CalendarEntry');
    expect(rows).toEqual([
      { role: 'DISPATCHER', action: 'read', subject: 'CalendarEntry' },
      { role: 'DISPATCHER', action: 'create', subject: 'CalendarEntry' },
      { role: 'DISPATCHER', action: 'update', subject: 'CalendarEntry' },
      { role: 'DISPATCHER', action: 'delete', subject: 'CalendarEntry' },
    ]);
  });

  it('grants ZERO SALES, ZERO TECHNICIAN and ZERO ADMIN CalendarEntry rows', () => {
    expect(DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'CalendarEntry')).toEqual([]);
    expect(DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN' && g.subject === 'CalendarEntry')).toEqual([]);
    // DEFAULT_GRANTS is typed to SALES|DISPATCHER|TECHNICIAN only — ADMIN can never appear in it
    // (it reaches every subject via the manage-all bypass) — but assert the subject-level count
    // directly rather than relying on the type alone.
    expect(DEFAULT_GRANTS.filter((g) => (g as { role: string }).role === 'ADMIN' && g.subject === 'CalendarEntry')).toEqual([]);
  });
});

describe('backfill migration — every existing org, idempotent', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260824180000_calendar_entry_dispatcher_grants_backfill/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('mirrors defaultGrants: every CalendarEntry row appears verbatim as a DISPATCHER tuple', () => {
    const expected = DEFAULT_GRANTS.filter((g) => g.subject === 'CalendarEntry');
    expect(expected.length).toBe(4);
    for (const g of expected) {
      const row = `('${g.role}','${g.action}','${g.subject}',NULL)`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
  });

  it('grants ONLY DISPATCHER — no SALES/TECHNICIAN/ADMIN CalendarEntry rows sneak in', () => {
    for (const role of ['SALES', 'TECHNICIAN', 'ADMIN']) {
      expect(sql).not.toContain(`('${role}','read','CalendarEntry'`);
      expect(sql).not.toContain(`('${role}','create','CalendarEntry'`);
      expect(sql).not.toContain(`('${role}','update','CalendarEntry'`);
      expect(sql).not.toContain(`('${role}','delete','CalendarEntry'`);
    }
  });
});

describe('roleViewModel — Events row on the Roles & Permissions matrix', () => {
  it('MODULES carries a CalendarEntry entry labelled Events', () => {
    expect(MODULES).toContainEqual({ subject: 'CalendarEntry', label: 'Events' });
  });
});

describe('GET/PUT /api/roles/DISPATCHER/permissions — Events row round-trips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
  });

  it('GET renders the Events row with all four DISPATCHER cells ticked', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue(
      DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.subject === 'CalendarEntry').map((g) => ({
        action: g.action,
        subject: g.subject,
        conditions: null,
      })),
    );
    const res = await request(app).get('/api/roles/DISPATCHER/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.matrix.CalendarEntry).toEqual({ read: true, create: true, update: true, delete: true });
  });

  it('GET renders SALES Events cells unticked (no default grant)', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue([]);
    const res = await request(app).get('/api/roles/SALES/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.matrix.CalendarEntry).toEqual({ read: false, create: false, update: false, delete: false });
  });

  it('a Save round-trips the Events row without dropping an unrelated existing grant', async () => {
    mockAuthAs('admin');
    // Existing stored state: DISPATCHER already holds `read Customer` (unrelated to this Save).
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'read', subject: 'Customer', conditions: null },
    ]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));

    const res = await request(app)
      .put('/api/roles/DISPATCHER/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: {
          Customer: { read: true, create: false, update: false, delete: false },
          CalendarEntry: { read: true, create: true, update: true, delete: true },
        },
        sensitive: { seeFinancials: false, managePayments: false, viewReports: false, editRecordIds: false, assignOthers: false },
        toggles: {},
        scope: {},
        general: { description: '' },
      });

    expect(res.status).toBe(200);
    const persisted = upsert.mock.calls.map((c: any) => ({ action: c[0].create.action, subject: c[0].create.subject }));
    // The unrelated Customer grant is still asked to be upserted (unticked nothing there)...
    expect(persisted).toContainEqual({ action: 'read', subject: 'Customer' });
    // ...and all four CalendarEntry grants were written, unconditionally.
    for (const action of ['read', 'create', 'update', 'delete']) {
      expect(persisted).toContainEqual({ action, subject: 'CalendarEntry' });
    }
    // role.controller.ts writes an absent condition as Prisma.JsonNull (the JSON-column sentinel),
    // not a bare JS `null` — see putRolePermissions' upsert calls.
    const calendarUpserts = upsert.mock.calls.filter((c: any) => c[0].create.subject === 'CalendarEntry');
    expect(calendarUpserts).toHaveLength(4);
    for (const c of calendarUpserts) {
      expect(c[0].create.conditions).toEqual(Prisma.JsonNull);
    }
  });
});

describe('defineAbilityFor — real ability build, not a literal', () => {
  it('ADMIN reaches CalendarEntry via manage-all (no explicit row needed)', () => {
    const ability = defineAbilityFor({ id: 'u1', role: 'ADMIN' }, []);
    expect(ability.can('read', 'CalendarEntry')).toBe(true);
    expect(ability.can('create', 'CalendarEntry')).toBe(true);
    expect(ability.can('update', 'CalendarEntry')).toBe(true);
    expect(ability.can('delete', 'CalendarEntry')).toBe(true);
  });

  it('DISPATCHER reaches all four CRUD actions, unconditionally, from DEFAULT_GRANTS alone', () => {
    const grants = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.subject === 'CalendarEntry');
    const ability = defineAbilityFor({ id: 'u2', role: 'DISPATCHER' }, grants);
    expect(ability.can('read', 'CalendarEntry')).toBe(true);
    expect(ability.can('create', 'CalendarEntry')).toBe(true);
    expect(ability.can('update', 'CalendarEntry')).toBe(true);
    expect(ability.can('delete', 'CalendarEntry')).toBe(true);
  });

  it('SALES holds nothing on CalendarEntry by default (zero role grants)', () => {
    const ability = defineAbilityFor({ id: 'u3', role: 'SALES' }, []);
    expect(ability.can('read', 'CalendarEntry')).toBe(false);
    expect(ability.can('create', 'CalendarEntry')).toBe(false);
  });

  it('a SALES user granted the per-user "create CalendarEntry" override gets create AND read, org-wide (unconditional)', () => {
    const ability = defineAbilityFor(
      { id: 'u4', role: 'SALES' },
      [],
      [{ action: 'create', subject: 'CalendarEntry', effect: 'allow' }],
    );
    expect(ability.can('create', 'CalendarEntry')).toBe(true);
    // impliesRead: the paired read comes along automatically.
    expect(ability.can('read', 'CalendarEntry')).toBe(true);
    // CalendarEntry has no ownership chain (ADR 0002 / spec §4: visibility is org-wide) — the
    // capability carries no ownCondition, so the emitted `can` must be UNCONDITIONAL, not
    // own-scoped. Assert this on the real rule rather than assuming it (RECON's explicit warning).
    const createRule = ability.rules.find((r) => r.action === 'create' && r.subject === 'CalendarEntry');
    expect(createRule?.conditions).toBeUndefined();
  });
});
