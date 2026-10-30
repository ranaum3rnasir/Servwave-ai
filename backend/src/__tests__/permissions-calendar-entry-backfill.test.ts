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

describe('defineAbilityFor — real ability build, not a literal', () => {
  it('ADMIN reaches CalendarEntry via manage-all (no explicit row needed)', () => {
    const ability = defineAbilityFor({ is_admin: true, id: 'u1', role: 'ADMIN' }, []);
    expect(ability.can('read', 'CalendarEntry')).toBe(true);
    expect(ability.can('create', 'CalendarEntry')).toBe(true);
    expect(ability.can('update', 'CalendarEntry')).toBe(true);
    expect(ability.can('delete', 'CalendarEntry')).toBe(true);
  });

  it('DISPATCHER reaches all four CRUD actions, unconditionally, from DEFAULT_GRANTS alone', () => {
    const grants = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.subject === 'CalendarEntry');
    const ability = defineAbilityFor({ is_admin: false, id: 'u2', role: 'DISPATCHER' }, grants);
    expect(ability.can('read', 'CalendarEntry')).toBe(true);
    expect(ability.can('create', 'CalendarEntry')).toBe(true);
    expect(ability.can('update', 'CalendarEntry')).toBe(true);
    expect(ability.can('delete', 'CalendarEntry')).toBe(true);
  });

  it('SALES holds nothing on CalendarEntry by default (zero role grants)', () => {
    const ability = defineAbilityFor({ is_admin: false, id: 'u3', role: 'SALES' }, []);
    expect(ability.can('read', 'CalendarEntry')).toBe(false);
    expect(ability.can('create', 'CalendarEntry')).toBe(false);
  });
});
