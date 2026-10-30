import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';
import { BUILT_IN_ROLES, SWITCH_CATALOG } from './catalog';
import { loadPresetMigrationSnapshot } from './presetMigrationSnapshot';
import { PRESET_MIGRATION_NAME, planQuery } from './presetMigration';

/**
 * The three checks around the preset migration (Roles & Permissions, slice S01.22): the dry run that previews it, the
 * proof check that shows it landed, and the drift checker that compares stored role sets with the catalog presets.
 *
 * Each runs against any database URL in a READ-ONLY transaction that is rolled back, and prints counts and ids only:
 * never a company name, a person's name or an email.
 */

type Db = Pick<PrismaClient, '$transaction'>;
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

class RollBack extends Error {}

/** Runs the callback in a read-only transaction, then rolls it back whatever happened. */
export async function inReadOnlyTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  let out: { value: T } | undefined;
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        // The tables carry row-level security; the setting is a read-only-safe session value, not a write.
        await tx.$queryRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
        out = { value: await work(tx) };
        throw new RollBack();
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
  } catch (err) {
    if (!(err instanceof RollBack)) throw err;
  }
  return out!.value;
}

/** The migration file, read from disk: the dry run previews exactly the text that will run. */
export function presetMigrationSql(): string {
  return readFileSync(join(__dirname, '..', '..', '..', '..', 'prisma', 'migrations', PRESET_MIGRATION_NAME, 'migration.sql'), 'utf8');
}

// ─── Dry run ────────────────────────────────────────────────────────────────────────────────────────

export interface OrgCounts {
  organization_id: string;
  role_rows_to_write: number;
  custom_roles_translated: number;
  sales_unknown_shapes: number;
  people_filled: number;
  people_changed: number;
  user_rows_to_write: number;
  log_entries: number;
  dropped_grants: number;
  overrides_ignored: number;
}

export interface DryRunReport {
  organizations: number;
  perOrg: OrgCounts[];
  /** Sales' scope per record type: how many organizations fall in each mapping case. */
  salesScope: Record<string, Record<'default' | 'all' | 'crew_only' | 'unknown_shape' | 'no_row', number>>;
  salesUnknownShapes: Array<{ organization_id: string; switch_key: string }>;
  customRoles: { translated: number; alreadyOnSwitches: number };
  customUnknownShapes: Array<{ custom_role_id: string; subject: string }>;
  dropped: Array<{ organization_id: string; custom_role_id: string; action: string; subject: string }>;
  ignoredOverrides: Array<{ organization_id: string; user_id: string; action: string; subject: string; effect: string }>;
  totals: {
    roleRowsToWrite: number;
    peopleFilled: number;
    peopleChanged: number;
    personRowsToWrite: number;
    logEntries: number;
  };
}

const SCOPE_CASE: Record<string, 'default' | 'all' | 'crew_only' | 'unknown_shape'> = {
  own_leads: 'default', all: 'all', attached: 'crew_only', other: 'unknown_shape',
};

/** What the migration would do, computed by the migration's own plan in a read-only transaction. Writes nothing. */
export async function dryRunReport(db: Db, sql: string = presetMigrationSql()): Promise<DryRunReport> {
  const query = planQuery(
    sql,
    `SELECT
      (SELECT count(*) FROM organizations) AS organizations,
      (SELECT count(*) FROM custom_roles) AS custom_roles_total,
      (SELECT COALESCE(json_agg(r ORDER BY r.organization_id), '[]'::json) FROM s01_22_report r) AS per_org,
      (SELECT COALESCE(json_agg(json_build_object('switch_key', switch_key, 'class', class, 'organization_id', organization_id)), '[]'::json) FROM s01_22_sales_scope) AS sales_scope,
      (SELECT COALESCE(json_agg(json_build_object('custom_role_id', c.custom_role_id, 'subject', r.subject) ORDER BY c.custom_role_id, r.subject), '[]'::json)
         FROM s01_22_read r JOIN s01_22_custom c ON c.organization_id = r.organization_id AND c.role_key = r.role_key WHERE r.class = 'other') AS custom_unknown,
      (SELECT count(*) FROM s01_22_custom) AS custom_translated,
      (SELECT COALESCE(json_agg(d ORDER BY d.organization_id, d.custom_role_id, d.action, d.subject), '[]'::json) FROM s01_22_dropped d) AS dropped,
      (SELECT COALESCE(json_agg(o ORDER BY o.organization_id, o.user_id, o.action, o.subject), '[]'::json) FROM s01_22_ignored_overrides o) AS ignored_overrides`,
  );
  const rows = await inReadOnlyTransaction(db, (tx) => tx.$queryRawUnsafe<Array<Record<string, unknown>>>(query));
  const row = rows[0]!;
  const num = (v: unknown) => Number(v);
  const perOrg = (row.per_org as OrgCounts[]).map((o) => ({
    ...o,
    role_rows_to_write: num(o.role_rows_to_write), custom_roles_translated: num(o.custom_roles_translated),
    sales_unknown_shapes: num(o.sales_unknown_shapes), people_filled: num(o.people_filled), people_changed: num(o.people_changed),
    user_rows_to_write: num(o.user_rows_to_write), log_entries: num(o.log_entries), dropped_grants: num(o.dropped_grants),
    overrides_ignored: num(o.overrides_ignored),
  }));
  const organizations = num(row.organizations);

  const salesScope: DryRunReport['salesScope'] = {};
  const scopeRows = row.sales_scope as Array<{ switch_key: string; class: string; organization_id: string }>;
  for (const key of ['jobs_scope', 'estimates_scope', 'invoices_scope']) {
    const own = scopeRows.filter((r) => r.switch_key === key);
    const counts = { default: 0, all: 0, crew_only: 0, unknown_shape: 0, no_row: 0 };
    for (const r of own) counts[SCOPE_CASE[r.class]!]++;
    counts.no_row = Math.max(0, organizations - own.length);
    salesScope[key] = counts;
  }
  const salesUnknownShapes = scopeRows
    .filter((r) => r.class === 'other')
    .map((r) => ({ organization_id: r.organization_id, switch_key: r.switch_key }));

  const sum = (pick: (o: OrgCounts) => number) => perOrg.reduce((n, o) => n + pick(o), 0);
  return {
    organizations,
    perOrg,
    salesScope,
    salesUnknownShapes,
    customRoles: { translated: num(row.custom_translated), alreadyOnSwitches: num(row.custom_roles_total) - num(row.custom_translated) },
    customUnknownShapes: row.custom_unknown as DryRunReport['customUnknownShapes'],
    dropped: row.dropped as DryRunReport['dropped'],
    ignoredOverrides: row.ignored_overrides as DryRunReport['ignoredOverrides'],
    totals: {
      roleRowsToWrite: sum((o) => o.role_rows_to_write),
      peopleFilled: sum((o) => o.people_filled),
      peopleChanged: sum((o) => o.people_changed),
      personRowsToWrite: sum((o) => o.user_rows_to_write),
      logEntries: sum((o) => o.log_entries),
    },
  };
}

/** The lines the dry run prints: counts and ids, never a name. */
export function formatDryRunReport(r: DryRunReport): string[] {
  const out: string[] = ['Preset migration dry run (read-only, nothing written)'];
  out.push(`organizations: ${r.organizations}`);
  out.push(`built-in role rows to write: ${r.totals.roleRowsToWrite}`);
  for (const [key, c] of Object.entries(r.salesScope)) {
    out.push(
      `Sales ${key}: default (Through own leads) ${c.default}, no condition (All) ${c.all}, crew-only (Attached) ${c.crew_only}, ` +
        `unknown shape (Through own leads, reported) ${c.unknown_shape}, no read row ${c.no_row}`,
    );
  }
  out.push(`custom roles translated: ${r.customRoles.translated} (already on the switch store, left as they are: ${r.customRoles.alreadyOnSwitches})`);
  out.push(`people filled from their role: ${r.totals.peopleFilled} (whose values change: ${r.totals.peopleChanged}, person rows to write: ${r.totals.personRowsToWrite})`);
  out.push(`change log entries to write (reason migration): ${r.totals.logEntries}`);
  out.push(`Sales unknown shapes: ${r.salesUnknownShapes.length}`);
  for (const u of r.salesUnknownShapes) out.push(`  organization ${u.organization_id} ${u.switch_key}`);
  out.push(`custom role unknown shapes: ${r.customUnknownShapes.length}`);
  for (const u of r.customUnknownShapes) out.push(`  custom role ${u.custom_role_id} ${u.subject}`);
  out.push(`grants with no switch, dropped: ${r.dropped.length}`);
  const perGrant = new Map<string, number>();
  for (const d of r.dropped) perGrant.set(`${d.action} ${d.subject}`, (perGrant.get(`${d.action} ${d.subject}`) ?? 0) + 1);
  for (const [grant, n] of [...perGrant].sort()) out.push(`  ${grant}: ${n} custom role(s)`);
  for (const d of r.dropped) out.push(`  organization ${d.organization_id} custom role ${d.custom_role_id} ${d.action} ${d.subject}`);
  out.push(`per-person entries ignored: ${r.ignoredOverrides.length}`);
  for (const o of r.ignoredOverrides) out.push(`  organization ${o.organization_id} person ${o.user_id} ${o.effect} ${o.action} ${o.subject}`);
  out.push('organizations the run changes anything in:');
  for (const o of r.perOrg) {
    if (!(o.role_rows_to_write || o.people_changed || o.custom_roles_translated || o.dropped_grants || o.overrides_ignored || o.sales_unknown_shapes)) continue;
    out.push(
      `  ${o.organization_id}: role rows ${o.role_rows_to_write}, custom roles ${o.custom_roles_translated}, sales unknown shapes ${o.sales_unknown_shapes}, ` +
        `people ${o.people_filled} (changed ${o.people_changed}), person rows ${o.user_rows_to_write}, log entries ${o.log_entries}, ` +
        `dropped grants ${o.dropped_grants}, ignored entries ${o.overrides_ignored}`,
    );
  }
  return out;
}

// ─── Proof ──────────────────────────────────────────────────────────────────────────────────────────

export interface ProofReport {
  catalogSize: number;
  organizations: number;
  /** Per built-in role: organizations with a full set of rows, a partial set, and none. */
  builtInRoles: Record<string, { full: number; partial: number; none: number }>;
  /** Organizations missing every row of a built-in role, as `organization:role`. */
  missingRoleRows: Array<{ organization_id: string; role_key: string; rows: number }>;
  customRoles: { total: number; withoutRows: string[] };
  people: { nonAdmin: number; withoutSet: string[]; notBasedOnRole: string[] };
  ok: boolean;
}

/** Counts the switch rows per organization and role, and the people filled. Writes nothing. */
export async function proofReport(db: Db): Promise<ProofReport> {
  // Every switch the migration wrote, not the live catalog (it has grown since): see presetMigrationSnapshot.ts.
  const catalogSize = loadPresetMigrationSnapshot().switches.length;
  const rows = await inReadOnlyTransaction(db, async (tx) => {
    const orgs = await tx.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT count(*) AS n FROM organizations');
    const roleCounts = await tx.$queryRawUnsafe<Array<{ organization_id: string; role_key: string; n: bigint }>>(
      `SELECT o.id AS organization_id, r.role_key, count(s.id) AS n
       FROM organizations o CROSS JOIN (VALUES ${BUILT_IN_ROLES.map((r) => `('${r}')`).join(', ')}) r(role_key)
       LEFT JOIN permission_role_switches s ON s.organization_id = o.id AND s.role_key = r.role_key
       GROUP BY o.id, r.role_key`,
    );
    const custom = await tx.$queryRawUnsafe<Array<{ id: string; n: bigint }>>(
      `SELECT c.id, count(s.id) AS n FROM custom_roles c
       LEFT JOIN permission_role_switches s ON s.organization_id = c.organization_id AND s.role_key = c.key
       GROUP BY c.id`,
    );
    const people = await tx.$queryRawUnsafe<Array<{ id: string; n: bigint; based: boolean }>>(
      `SELECT u.id, count(s.id) AS n,
              (u.based_on_role_key IS NOT DISTINCT FROM COALESCE(cr.key, u.role::text)) AS based
       FROM users u
       LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
       LEFT JOIN permission_user_switches s ON s.user_id = u.id
       WHERE NOT (u.role = 'ADMIN' AND u.custom_role_id IS NULL)
       GROUP BY u.id, u.based_on_role_key, cr.key, u.role`,
    );
    return { orgs, roleCounts, custom, people };
  });

  const builtInRoles: ProofReport['builtInRoles'] = Object.fromEntries(BUILT_IN_ROLES.map((r) => [r, { full: 0, partial: 0, none: 0 }]));
  const missingRoleRows: ProofReport['missingRoleRows'] = [];
  for (const rc of rows.roleCounts) {
    const n = Number(rc.n);
    const bucket = builtInRoles[rc.role_key]!;
    if (n === 0) {
      bucket.none++;
      missingRoleRows.push({ organization_id: rc.organization_id, role_key: rc.role_key, rows: n });
    } else if (n < catalogSize) bucket.partial++;
    else bucket.full++;
  }
  const withoutRows = rows.custom.filter((c) => Number(c.n) === 0).map((c) => c.id);
  const withoutSet = rows.people.filter((p) => Number(p.n) === 0).map((p) => p.id);
  const notBasedOnRole = rows.people.filter((p) => !p.based).map((p) => p.id);
  return {
    catalogSize,
    organizations: Number(rows.orgs[0]!.n),
    builtInRoles,
    missingRoleRows,
    customRoles: { total: rows.custom.length, withoutRows },
    people: { nonAdmin: rows.people.length, withoutSet, notBasedOnRole },
    ok: missingRoleRows.length === 0 && withoutRows.length === 0 && withoutSet.length === 0 && notBasedOnRole.length === 0,
  };
}

/** The first lines of a long list of ids, then how many more there are: a failing proof must not bury the summary. */
const LISTED = 40;
function listed<T>(items: T[], line: (item: T) => string): string[] {
  const out = items.slice(0, LISTED).map(line);
  if (items.length > LISTED) out.push(`  ... and ${items.length - LISTED} more`);
  return out;
}

export function formatProofReport(r: ProofReport): string[] {
  const out = [`Preset migration proof (read-only): ${r.organizations} organizations, catalog holds ${r.catalogSize} switches`];
  for (const [role, c] of Object.entries(r.builtInRoles)) {
    out.push(`${role}: organizations with all rows ${c.full}, with some rows ${c.partial}, with none ${c.none}`);
  }
  out.push(`built-in roles with no rows: ${r.missingRoleRows.length}`);
  out.push(...listed(r.missingRoleRows, (m) => `  NO ROWS: organization ${m.organization_id} role ${m.role_key}`));
  out.push(`custom roles: ${r.customRoles.total}, without rows ${r.customRoles.withoutRows.length}`);
  out.push(...listed(r.customRoles.withoutRows, (id) => `  NO ROWS: custom role ${id}`));
  out.push(`people not in the Admin box: ${r.people.nonAdmin}, without a set ${r.people.withoutSet.length}, not based on their role ${r.people.notBasedOnRole.length}`);
  out.push(...listed(r.people.withoutSet, (id) => `  NO SET: person ${id}`));
  out.push(...listed(r.people.notBasedOnRole, (id) => `  NOT BASED ON ROLE: person ${id}`));
  out.push(r.ok ? 'PROOF OK: every organization and role holds switch rows and every person is filled.' : 'PROOF FAILED: see the lines above.');
  return out;
}

// ─── Drift ──────────────────────────────────────────────────────────────────────────────────────────

export interface DriftReport {
  organizations: number;
  /** A stored built-in role value that differs from the catalog preset. */
  drifted: Array<{ organization_id: string; role_key: string; switch_key: string; stored: unknown; preset: unknown }>;
  /** A stored built-in role row for a switch the catalog no longer holds. */
  unknownSwitches: Array<{ organization_id: string; role_key: string; switch_key: string }>;
  /** Built-in role rows the store does not hold; they resolve to the preset, so this is not drift. */
  rowsNotStored: number;
}

const jsonLiteral = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;

/** Compares every organization's stored built-in role sets with the catalog presets. Writes nothing. */
export async function driftReport(db: Db): Promise<DriftReport> {
  const pre = BUILT_IN_ROLES.flatMap((role) =>
    SWITCH_CATALOG.map((s) => `('${role}', '${s.key}', ${jsonLiteral(s.presets[role])})`),
  ).join(',\n');
  const roleList = BUILT_IN_ROLES.map((r) => `'${r}'`).join(', ');
  return inReadOnlyTransaction(db, async (tx) => {
    const drifted = await tx.$queryRawUnsafe<DriftReport['drifted']>(
      `WITH pre(role_key, switch_key, value) AS (VALUES ${pre})
       SELECT s.organization_id, s.role_key, s.switch_key, s.value AS stored, p.value AS preset
       FROM permission_role_switches s
       JOIN pre p ON p.role_key = s.role_key AND p.switch_key = s.switch_key
       WHERE s.value IS DISTINCT FROM p.value
       ORDER BY s.organization_id, s.role_key, s.switch_key`,
    );
    const unknownSwitches = await tx.$queryRawUnsafe<DriftReport['unknownSwitches']>(
      `SELECT s.organization_id, s.role_key, s.switch_key FROM permission_role_switches s
       WHERE s.role_key IN (${roleList}) AND s.switch_key NOT IN (${SWITCH_CATALOG.map((s) => `'${s.key}'`).join(', ')})
       ORDER BY s.organization_id, s.role_key, s.switch_key`,
    );
    const counts = await tx.$queryRawUnsafe<Array<{ organizations: bigint; stored_rows: bigint }>>(
      `SELECT (SELECT count(*) FROM organizations) AS organizations,
              (SELECT count(*) FROM permission_role_switches s WHERE s.role_key IN (${roleList})
                 AND s.switch_key IN (${SWITCH_CATALOG.map((s) => `'${s.key}'`).join(', ')})) AS stored_rows`,
    );
    const organizations = Number(counts[0]!.organizations);
    const rowsNotStored = organizations * BUILT_IN_ROLES.length * SWITCH_CATALOG.length - Number(counts[0]!.stored_rows);
    return { organizations, drifted, unknownSwitches, rowsNotStored };
  });
}

export function formatDriftReport(r: DriftReport): string[] {
  const out = [`Permission drift check (read-only): ${r.organizations} organizations, stored built-in role sets against the catalog presets`];
  const orgs = new Set(r.drifted.map((d) => d.organization_id));
  out.push(`organizations with drift: ${orgs.size}, drifting values: ${r.drifted.length}`);
  out.push(...listed(r.drifted, (d) => `  organization ${d.organization_id} ${d.role_key} ${d.switch_key}: stored ${JSON.stringify(d.stored)}, preset ${JSON.stringify(d.preset)}`));
  out.push(`stored rows for switches the catalog no longer holds: ${r.unknownSwitches.length}`);
  out.push(...listed(r.unknownSwitches, (u) => `  organization ${u.organization_id} ${u.role_key} ${u.switch_key}`));
  out.push(`built-in role rows not stored (they resolve to the preset, not drift): ${r.rowsNotStored}`);
  if (r.drifted.length === 0 && r.unknownSwitches.length === 0) out.push('No drift: every stored built-in role set matches the catalog presets.');
  return out;
}
