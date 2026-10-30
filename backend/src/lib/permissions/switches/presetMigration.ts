import { BUILT_IN_ROLES, SWITCH_CATALOG, THROUGH_OWN_LEADS, type SwitchEntry, type SwitchValue } from './catalog';
import { PERMISSION_CATALOG } from '../catalog';
import { DEFAULT_GRANTS } from '../defaultGrants';
import { FIXED_GRANTS } from '../fixedGrants';
import { grantKey } from './ownership';

/**
 * The preset migration (Roles & Permissions, PRD 1, slice S01.22): one idempotent SQL file that, for every
 * organization, writes the four built-in presets into the switch store, translates each custom role from the
 * grants it holds today, and fills every non-admin person from their role alone.
 *
 * The file was GENERATED from here, so the preset values in it were read from the switch catalog and never typed by
 * hand. It has since been applied on staging and is FROZEN: it is never regenerated or edited again (it runs on
 * production as it is). `npm run permissions:check-preset-migration` holds it against the frozen snapshot
 * (presetMigrationSnapshotData.ts) and names the switches that need a follow-up migration after a later catalog
 * change. The dry run and the proof check read the file's own text, so what is previewed is what runs.
 *
 * Shape of the file: a DO block that builds the plan into temporary tables, step by step (each step is a
 * `-- @step name` ... `-- @end` region holding one SELECT), prints the per-organization counts, writes from the
 * plan, and proves the rows landed. The steps are plain SELECTs over the live tables and earlier steps, which is
 * what lets the dry run run them as one read-only query (see `planSteps` / `planQuery`).
 */

/** The migration's folder name; sorts after every migration that exists when this slice is built. */
export const PRESET_MIGRATION_NAME = '20261012120000_permission_preset_migration';

/** Temporary table names are prefixed so a step can be told apart from the live tables it reads. */
const T = 's01_22_';

// ─── Literals ──────────────────────────────────────────────────────────────────────────────────────

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const jsonb = (v: unknown): string => `${q(JSON.stringify(v))}::jsonb`;

/** The Roles editor of old wrote these condition templates into role_permissions; the migration recognises them. */
const USER = '{{userId}}';
const LEAD_ASSIGNEE = { lead_assignees: { some: { user_id: USER } } };
const VISIT_CREW = { visits: { some: { assignees: { some: { user_id: USER } } } } };
const PRE_VISIT_CREW = { assignees: { some: { user_id: USER } } };

/**
 * Every condition shape of a read row that means something, per record type. Anything not listed here is an
 * unknown shape: reported, and given the role's starting value. `own_leads` is "reached through a lead the
 * person is an assignee of" (today's default for Sales), `attached` is "crew only" (and, for leads, the lead's
 * people and walkthrough crew), a null condition is "all".
 */
const SHAPES: Array<{ subject: string; cls: 'attached' | 'own_leads'; cond: unknown }> = [
  { subject: 'Lead', cls: 'attached', cond: LEAD_ASSIGNEE },
  { subject: 'Lead', cls: 'attached', cond: VISIT_CREW },
  // The walkthrough-performer shapes this one replaced, as they were stored before the move to visits.
  { subject: 'Lead', cls: 'attached', cond: { walkthrough_performers: { some: { user_id: USER } } } },
  { subject: 'Lead', cls: 'attached', cond: { walkthroughs: { some: { performers: { some: { user_id: USER } } } } } },
  { subject: 'Job', cls: 'own_leads', cond: { estimate: { lead: LEAD_ASSIGNEE } } },
  { subject: 'Job', cls: 'attached', cond: VISIT_CREW },
  { subject: 'Job', cls: 'attached', cond: PRE_VISIT_CREW },
  // The crew-or-creator shape the old editor's "Owned" chip also recognised (the Technician default): crew, plus the
  // person who made the job, who is put on its crew when they make it.
  { subject: 'Job', cls: 'attached', cond: { OR: [VISIT_CREW, { created_by_id: USER }] } },
  { subject: 'Job', cls: 'attached', cond: { OR: [PRE_VISIT_CREW, { created_by_id: USER }] } },
  { subject: 'Estimate', cls: 'own_leads', cond: { lead: LEAD_ASSIGNEE } },
  // Today's default for Sales: through the lead, or lead-less and created by the person.
  {
    subject: 'Estimate',
    cls: 'own_leads',
    cond: { OR: [{ lead: LEAD_ASSIGNEE }, { AND: [{ lead_id: null }, { created_by: USER }] }] },
  },
  { subject: 'Invoice', cls: 'own_leads', cond: { job: { estimate: { lead: LEAD_ASSIGNEE } } } },
  { subject: 'Invoice', cls: 'attached', cond: { job: VISIT_CREW } },
  { subject: 'Invoice', cls: 'attached', cond: { job: PRE_VISIT_CREW } },
];

/** Where each record type's Data Scope lives, and whether the kept "Through own leads" value is storable on it. */
const SCOPE_SUBJECTS: Array<{ subject: string; switchKey: string }> = [
  { subject: 'Lead', switchKey: 'leads_scope' },
  { subject: 'Job', switchKey: 'jobs_scope' },
  { subject: 'Estimate', switchKey: 'estimates_scope' },
  { subject: 'Invoice', switchKey: 'invoices_scope' },
];

/**
 * A role that could send an invoice keeps making its payment link: the switch the old grant split into. Everything else
 * reads its own grant. (Invite users, which read the create-user grant, retired with AL-18.)
 */
const SOURCE_OVERRIDES: Record<string, { action: string; subject: string }> = {
  send_payment_links: { action: 'send', subject: 'Invoice' },
};

/** Grants the old editor could write that no switch emits as such, but whose power a switch already carries. */
const FOLDED_GRANTS = [{ action: 'archive', subject: 'Estimate' }];

// ─── Derived from the catalog and the retired grant registry ───────────────────────────────────────

/** The (action, subject) pairs the old Roles editor could write into role_permissions. */
function legacyPairs(): Set<string> {
  const pairs = new Set<string>();
  for (const e of PERMISSION_CATALOG) pairs.add(grantKey(e));
  for (const g of DEFAULT_GRANTS) pairs.add(grantKey(g));
  return pairs;
}

/** The one old grant a switch is read from: its first grant that existed as a role grant, or an override. */
export function legacySource(sw: SwitchEntry, legacy: Set<string> = legacyPairs()): { action: string; subject: string } | null {
  const override = SOURCE_OVERRIDES[sw.key];
  if (override) return override;
  if (sw.kind !== 'toggle') return null;
  return sw.grants.find((g) => legacy.has(grantKey(g))) ?? null;
}

function narrowest(sw: SwitchEntry): SwitchValue {
  return sw.kind === 'choice' ? sw.choices![0]! : sw.kind === 'list' ? [] : false;
}

/** The longest chain of "needs" in the catalog: the number of passes a role needs to settle (a switch off turns its dependants off). */
function requiresDepth(): number {
  const needs = (s: SwitchEntry) => [...s.requires, ...(s.requiresAny ?? [])];
  const byKey = new Map(SWITCH_CATALOG.map((s) => [s.key, s]));
  const depth = (key: string, seen: string[]): number => {
    const s = byKey.get(key);
    if (!s || seen.includes(key)) return 0;
    return 1 + Math.max(0, ...needs(s).map((n) => depth(n, [...seen, key])));
  };
  return Math.max(1, ...SWITCH_CATALOG.map((s) => depth(s.key, []) - 1));
}

// ─── The file ──────────────────────────────────────────────────────────────────────────────────────

const rows = (lines: string[]): string => lines.map((l) => `    ${l}`).join(',\n');

function dataSteps(): Array<{ name: string; select: string }> {
  const legacy = legacyPairs();
  const sw = rows(SWITCH_CATALOG.map((s) => `(${q(s.key)}, ${q(s.kind)}, ${jsonb(narrowest(s))})`));
  const pre = rows(
    BUILT_IN_ROLES.flatMap((role) =>
      SWITCH_CATALOG.map((s) => `(${q(role)}, ${q(s.key)}, ${jsonb(s.presets[role])})`),
    ),
  );
  const src = rows(
    SWITCH_CATALOG.flatMap((s) => {
      const g = legacySource(s, legacy);
      return g ? [`(${q(s.key)}, ${q(g.action)}, ${q(g.subject)})`] : [];
    }),
  );
  const req = rows(
    SWITCH_CATALOG.flatMap((s) => [
      ...s.requires.map((n) => `(${q(s.key)}, ${q(n)}, false)`),
      ...(s.requiresAny ?? []).map((n) => `(${q(s.key)}, ${q(n)}, true)`),
    ]),
  );
  const scopeSw = rows(
    SCOPE_SUBJECTS.map(({ subject, switchKey }) => {
      const entry = SWITCH_CATALOG.find((s) => s.key === switchKey);
      return `(${q(switchKey)}, ${q(subject)}, ${entry?.keptValues?.includes(THROUGH_OWN_LEADS) ? 'true' : 'false'})`;
    }),
  );
  const shape = rows(SHAPES.map((s) => `(${q(s.subject)}, ${q(s.cls)}, ${jsonb(s.cond)})`));
  const mappedPairs = new Map<string, { action: string; subject: string; how: string }>();
  for (const s of SWITCH_CATALOG) for (const g of s.grants) mappedPairs.set(grantKey(g), { action: g.action, subject: g.subject, how: 'switch' });
  for (const g of FIXED_GRANTS) mappedPairs.set(grantKey(g), { action: g.action, subject: g.subject, how: 'fixed' });
  for (const g of FOLDED_GRANTS) mappedPairs.set(grantKey(g), { ...g, how: 'folded' });
  const mapped = rows([...mappedPairs.values()].map((m) => `(${q(m.action)}, ${q(m.subject)}, ${q(m.how)})`));

  return [
    { name: 'sw', select: `SELECT * FROM (VALUES\n${sw}\n  ) v(switch_key, kind, narrowest)` },
    { name: 'pre', select: `SELECT * FROM (VALUES\n${pre}\n  ) v(role_key, switch_key, value)` },
    { name: 'src', select: `SELECT * FROM (VALUES\n${src}\n  ) v(switch_key, action, subject)` },
    { name: 'req', select: `SELECT * FROM (VALUES\n${req}\n  ) v(switch_key, needed_key, any_of)` },
    { name: 'scope_sw', select: `SELECT * FROM (VALUES\n${scopeSw}\n  ) v(switch_key, subject, keeps_own_leads)` },
    { name: 'shape', select: `SELECT * FROM (VALUES\n${shape}\n  ) v(subject, class, cond)` },
    { name: 'mapped', select: `SELECT * FROM (VALUES\n${mapped}\n  ) v(action, subject, how)` },
  ];
}

const ROLE_WORDS = BUILT_IN_ROLES.map(q).join('), (');
const SCOPE_SUBJECT_LIST = SCOPE_SUBJECTS.map((s) => q(s.subject)).join(', ');

/**
 * One stage of settling a translated role: a switch whose need is off goes off too. Written as two grouped joins
 * (what each switch is missing, whether any of its "one of" group is on) so it plans as hash joins however small
 * the temporary tables look to the planner.
 */
function settleStage(from: string): string {
  return `SELECT r.organization_id, r.role_key, r.switch_key, r.prev_value,
    CASE WHEN r.value = 'true'::jsonb AND (COALESCE(m.missing, 0) > 0 OR (a.switch_key IS NOT NULL AND NOT a.any_on))
         THEN 'false'::jsonb ELSE r.value END AS value
  FROM ${from} r
  LEFT JOIN (
    SELECT n.organization_id, n.role_key, q.switch_key, count(*) FILTER (WHERE n.value IS DISTINCT FROM 'true'::jsonb) AS missing
    FROM ${T}req q JOIN ${from} n ON n.switch_key = q.needed_key
    WHERE NOT q.any_of
    GROUP BY n.organization_id, n.role_key, q.switch_key
  ) m ON m.organization_id = r.organization_id AND m.role_key = r.role_key AND m.switch_key = r.switch_key
  LEFT JOIN (
    SELECT n.organization_id, n.role_key, q.switch_key, bool_or(n.value = 'true'::jsonb) AS any_on
    FROM ${T}req q JOIN ${from} n ON n.switch_key = q.needed_key
    WHERE q.any_of
    GROUP BY n.organization_id, n.role_key, q.switch_key
  ) a ON a.organization_id = r.organization_id AND a.role_key = r.role_key AND a.switch_key = r.switch_key`;
}

function planSteps(): Array<{ name: string; select: string }> {
  const settle: Array<{ name: string; select: string }> = [];
  let last = `${T}custom_raw`;
  for (let i = 1; i <= requiresDepth(); i++) {
    settle.push({ name: `custom_settled_${i}`, select: settleStage(last) });
    last = `${T}custom_settled_${i}`;
  }
  return [
    // The four built-in roles of every organization.
    {
      name: 'builtin',
      select: `SELECT o.id AS organization_id, r.role_key FROM organizations o CROSS JOIN (VALUES (${ROLE_WORDS})) r(role_key)`,
    },
    // Custom roles that are not on the switch store yet: the ones the old grants have to be translated for. A role that
    // already holds switch rows was made on the new store and is never translated again.
    {
      name: 'custom',
      select: `SELECT c.id AS custom_role_id, c.organization_id, c.key AS role_key, c.base_role::text AS base_role, c.made_from_blank
  FROM custom_roles c
  WHERE NOT EXISTS (SELECT 1 FROM permission_role_switches s WHERE s.organization_id = c.organization_id AND s.role_key = c.key)`,
    },
    {
      name: 'held',
      select: `SELECT rp.organization_id, rp.role AS role_key, rp.action, rp.subject, rp.conditions
  FROM role_permissions rp
  JOIN ${T}custom c ON c.organization_id = rp.organization_id AND c.role_key = rp.role`,
    },
    // Each read row's reach, named: all, attached, own_leads (Through own leads) or other (an unknown shape).
    {
      name: 'read',
      select: `SELECT x.organization_id, x.role_key, x.subject,
    CASE
      WHEN x.conditions IS NULL OR x.conditions = 'null'::jsonb THEN 'all'
      ELSE COALESCE((SELECT sh.class FROM ${T}shape sh WHERE sh.subject = x.subject AND sh.cond = x.conditions LIMIT 1), 'other')
    END AS class
  FROM (
    SELECT organization_id, role AS role_key, subject, conditions
    FROM role_permissions
    WHERE role = 'SALES' AND action = 'read' AND subject IN (${SCOPE_SUBJECT_LIST})
    UNION ALL
    SELECT organization_id, role_key, subject, conditions
    FROM ${T}held
    WHERE action = 'read' AND subject IN (${SCOPE_SUBJECT_LIST})
  ) x`,
    },
    // Sales' Jobs, Estimates and Invoices scopes from its read rows. Leads stay at the preset (Attached). A default or an
    // unknown shape takes the preset (Through own leads); no read row at all takes it too.
    {
      name: 'sales_scope',
      select: `SELECT r.organization_id, r.role_key, w.switch_key, r.class,
    CASE r.class
      WHEN 'all' THEN '"all"'::jsonb
      WHEN 'attached' THEN '"attached"'::jsonb
      ELSE (SELECT p.value FROM ${T}pre p WHERE p.role_key = 'SALES' AND p.switch_key = w.switch_key)
    END AS value
  FROM ${T}read r
  JOIN ${T}scope_sw w ON w.subject = r.subject
  WHERE r.role_key = 'SALES' AND r.subject <> 'Lead'`,
    },
    // A custom role's scopes from its read rows; an unknown shape (or no row) is left to the role's starting value.
    {
      name: 'custom_scope',
      select: `SELECT c.organization_id, c.role_key, w.switch_key, r.class,
    CASE r.class
      WHEN 'all' THEN '"all"'::jsonb
      WHEN 'attached' THEN '"attached"'::jsonb
      WHEN 'own_leads' THEN CASE WHEN w.keeps_own_leads THEN '"${THROUGH_OWN_LEADS}"'::jsonb END
    END AS value
  FROM ${T}custom c
  JOIN ${T}read r ON r.organization_id = c.organization_id AND r.role_key = c.role_key
  JOIN ${T}scope_sw w ON w.subject = r.subject`,
    },
    // What a custom role starts from where no old grant speaks: the preset of the built-in role it was made from.
    {
      name: 'custom_base',
      select: `SELECT c.organization_id, c.role_key, w.switch_key,
    CASE WHEN c.made_from_blank THEN w.narrowest ELSE p.value END AS value
  FROM ${T}custom c
  CROSS JOIN ${T}sw w
  LEFT JOIN ${T}pre p ON p.role_key = c.base_role AND p.switch_key = w.switch_key`,
    },
    // A switch that stands for an old grant is on when the role held that grant; a scope reads its read row; the rest keep
    // the starting value.
    {
      name: 'custom_raw',
      select: `SELECT b.organization_id, b.role_key, b.switch_key, b.value AS prev_value,
    CASE
      WHEN sc.value IS NOT NULL THEN sc.value
      WHEN src.action IS NOT NULL THEN to_jsonb(EXISTS (
        SELECT 1 FROM ${T}held h
        WHERE h.organization_id = b.organization_id AND h.role_key = b.role_key AND h.action = src.action AND h.subject = src.subject))
      ELSE b.value
    END AS value
  FROM ${T}custom_base b
  LEFT JOIN ${T}src src ON src.switch_key = b.switch_key
  LEFT JOIN ${T}custom_scope sc ON sc.organization_id = b.organization_id AND sc.role_key = b.role_key AND sc.switch_key = b.switch_key`,
    },
    ...settle,
    // Every role row the migration would store, with the value the role resolved to before it (its preset) for the log.
    {
      name: 'role_plan',
      select: `SELECT u.organization_id, u.role_key, u.switch_key, u.value, u.prev_value, u.is_custom,
    (s.id IS NOT NULL) AS stored
  FROM (
    SELECT b.organization_id, b.role_key, p.switch_key, COALESCE(sc.value, p.value) AS value, p.value AS prev_value, false AS is_custom
    FROM ${T}builtin b
    JOIN ${T}pre p ON p.role_key = b.role_key
    LEFT JOIN ${T}sales_scope sc ON sc.organization_id = b.organization_id AND sc.role_key = b.role_key AND sc.switch_key = p.switch_key
    UNION ALL
    SELECT organization_id, role_key, switch_key, value, prev_value, true FROM ${last}
  ) u
  LEFT JOIN permission_role_switches s
    ON s.organization_id = u.organization_id AND s.role_key = u.role_key AND s.switch_key = u.switch_key`,
    },
    // Every non-admin person: the Admin box (built-in Admin, no custom role) is left alone.
    {
      name: 'people',
      select: `SELECT u.id AS user_id, u.organization_id, COALESCE(cr.key, u.role::text) AS role_key,
    COALESCE(u.based_on_role_key, cr.key, u.role::text) AS prior_key
  FROM users u
  LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
  WHERE NOT (u.role = 'ADMIN' AND u.custom_role_id IS NULL)`,
    },
    {
      name: 'role_keys',
      select: `SELECT organization_id, role_key FROM ${T}people UNION SELECT organization_id, prior_key FROM ${T}people`,
    },
    // A role's value for every switch before and after the migration: its stored value, else what this run stores for it,
    // else the preset of the built-in role it is (or was made from).
    {
      name: 'role_eff',
      select: `SELECT k.organization_id, k.role_key, w.switch_key,
    COALESCE(st.value, fb.value) AS before_value,
    COALESCE(st.value, rp.value, fb.value) AS after_value
  FROM ${T}role_keys k
  CROSS JOIN ${T}sw w
  LEFT JOIN custom_roles cr ON cr.organization_id = k.organization_id AND cr.key = k.role_key
  LEFT JOIN ${T}pre fbp ON fbp.role_key = COALESCE(cr.base_role::text, k.role_key) AND fbp.switch_key = w.switch_key
  CROSS JOIN LATERAL (SELECT CASE WHEN cr.made_from_blank THEN w.narrowest ELSE fbp.value END AS value) fb
  LEFT JOIN permission_role_switches st
    ON st.organization_id = k.organization_id AND st.role_key = k.role_key AND st.switch_key = w.switch_key
  LEFT JOIN ${T}role_plan rp
    ON rp.organization_id = k.organization_id AND rp.role_key = k.role_key AND rp.switch_key = w.switch_key AND NOT rp.stored`,
    },
    // A person's set after the migration is their role's, whatever they held before; own_value is what they held.
    {
      name: 'user_plan',
      select: `SELECT p.user_id, p.organization_id, a.switch_key, a.after_value AS value,
    COALESCE(o.value, b.before_value) AS prev_value, o.value AS own_value
  FROM ${T}people p
  JOIN ${T}role_eff a ON a.organization_id = p.organization_id AND a.role_key = p.role_key
  LEFT JOIN ${T}role_eff b ON b.organization_id = p.organization_id AND b.role_key = p.prior_key AND b.switch_key = a.switch_key
  LEFT JOIN permission_user_switches o ON o.user_id = p.user_id AND o.switch_key = a.switch_key`,
    },
    // The change log: only values that actually change are written.
    {
      name: 'log_plan',
      select: `SELECT organization_id, 'ROLE'::text AS target_type, role_key AS target_id, switch_key, prev_value AS from_value, value AS to_value
  FROM ${T}role_plan
  WHERE NOT stored AND prev_value IS DISTINCT FROM value
  UNION ALL
  SELECT organization_id, 'USER', user_id::text, switch_key, prev_value, value
  FROM ${T}user_plan
  WHERE prev_value IS DISTINCT FROM value`,
    },
    // What the dry run reports besides the counts.
    {
      name: 'dropped',
      select: `SELECT h.organization_id, c.custom_role_id, h.action, h.subject
  FROM ${T}held h
  JOIN ${T}custom c ON c.organization_id = h.organization_id AND c.role_key = h.role_key
  WHERE NOT EXISTS (SELECT 1 FROM ${T}mapped m WHERE m.action = h.action AND m.subject = h.subject)`,
    },
    {
      name: 'ignored_overrides',
      select: `SELECT o.organization_id, o.user_id, o.action, o.subject, o.effect
  FROM user_permission_overrides o
  JOIN ${T}people p ON p.user_id = o.user_id`,
    },
    {
      name: 'report',
      select: `SELECT o.id AS organization_id,
    COALESCE(rr.rows_to_write, 0) AS role_rows_to_write,
    COALESCE(cr.custom_roles, 0) AS custom_roles_translated,
    COALESCE(sc.unknown_shapes, 0) AS sales_unknown_shapes,
    COALESCE(pp.people, 0) AS people_filled,
    COALESCE(up.people_changed, 0) AS people_changed,
    COALESCE(up.rows_to_write, 0) AS user_rows_to_write,
    COALESCE(lg.entries, 0) AS log_entries,
    COALESCE(dr.dropped, 0) AS dropped_grants,
    COALESCE(ov.ignored, 0) AS overrides_ignored
  FROM organizations o
  LEFT JOIN (SELECT organization_id, count(*) AS rows_to_write FROM ${T}role_plan WHERE NOT stored GROUP BY organization_id) rr ON rr.organization_id = o.id
  LEFT JOIN (SELECT organization_id, count(*) AS custom_roles FROM ${T}custom GROUP BY organization_id) cr ON cr.organization_id = o.id
  LEFT JOIN (SELECT organization_id, count(*) AS unknown_shapes FROM ${T}sales_scope WHERE class = 'other' GROUP BY organization_id) sc ON sc.organization_id = o.id
  LEFT JOIN (SELECT organization_id, count(*) AS people FROM ${T}people GROUP BY organization_id) pp ON pp.organization_id = o.id
  LEFT JOIN (
    SELECT organization_id, count(DISTINCT user_id) FILTER (WHERE prev_value IS DISTINCT FROM value) AS people_changed,
           count(*) FILTER (WHERE own_value IS DISTINCT FROM value) AS rows_to_write
    FROM ${T}user_plan GROUP BY organization_id) up ON up.organization_id = o.id
  LEFT JOIN (SELECT organization_id, count(*) AS entries FROM ${T}log_plan GROUP BY organization_id) lg ON lg.organization_id = o.id
  LEFT JOIN (SELECT organization_id, count(*) AS dropped FROM ${T}dropped GROUP BY organization_id) dr ON dr.organization_id = o.id
  LEFT JOIN (SELECT organization_id, count(*) AS ignored FROM ${T}ignored_overrides GROUP BY organization_id) ov ON ov.organization_id = o.id`,
    },
  ];
}

/** Every step of the plan, in the order each reads the ones before it. The names carry no prefix. */
export function planStepDefinitions(): Array<{ name: string; select: string }> {
  return [...dataSteps(), ...planSteps()];
}

const stepBlock = (step: { name: string; select: string }): string =>
  `  -- @step ${T}${step.name}\n` +
  `  CREATE TEMP TABLE ${T}${step.name} ON COMMIT DROP AS\n  ${step.select};\n` +
  `  -- @end\n` +
  `  ANALYZE ${T}${step.name};\n`;

/** The text of the migration file. */
export function buildPresetMigrationSql(): string {
  const steps = planStepDefinitions().map(stepBlock).join('\n');
  return `-- Roles & Permissions Overhaul, PRD 1, slice S01.22: the preset migration.
--
-- GENERATED by backend/src/scripts/generate-preset-migration.ts from the switch catalog
-- (backend/src/lib/permissions/switches/presetMigration.ts). Do not edit by hand: change the generator and run
-- \`npm run permissions:generate-preset-migration\`. A test regenerates it and fails if the two disagree.
--
-- For EVERY organization:
--   1. The four built-in roles (Admin, Sales, Dispatcher, Technician) are written from the catalog presets, one row
--      per switch. Sales' Jobs, Estimates and Invoices scopes are read from its read rows in role_permissions: today's
--      default -> Through own leads; no condition -> All; the crew-only "Owned" shape -> Attached; any other shape ->
--      Through own leads, and counted as an unknown shape in the report. Sales' Leads scope is Attached.
--   2. Every custom role that is not on the switch store yet is translated from the grants it holds: a switch that
--      stands for an old grant is on when the role held that grant (the payments bundle -> Record payments, Refund
--      payments only with the refund grant; create-user -> Create users and Invite users; the logistic-order submit
--      grant adds nothing; walkthrough booking -> Book walkthroughs), a scope is read from the read row, and a switch
--      no old grant speaks for takes the preset of the built-in role the custom role was made from. A switch that
--      needs another switch that is off is turned off. A grant no switch stands for (the dashboard, cancel lead, ...)
--      is dropped and counted in the report. A custom role that already holds switch rows is left as it is.
--   3. Every person who is not in the Admin box is filled from their role alone: their set is their role's, whatever
--      they held before, and the role is recorded as their based-on role. The old per-person Allow/Deny entries are
--      ignored (counted in the report). The Admin box (built-in Admin, no custom role) is not touched.
--   4. Every value that changes is written to the change log with the reason "migration".
-- role_permissions and user_permission_overrides are read, never changed or deleted: they stay for rollback.
--
-- IDEMPOTENT: a built-in or custom role that already holds a switch row keeps it; a person whose value already
-- equals the planned one is not rewritten; nothing is logged for a value that does not change. A second run
-- changes nothing.
--
-- Before it writes it prints per-organization counts (NOTICE lines, ids and counts only). After it writes it proves
-- every planned row landed with its planned value and stops, rolling everything back, if one did not (a
-- row-level-security setting can no-op a write under a green ledger).
--
-- SET-BASED: temporary tables built from the live tables, then four INSERT/UPDATE statements. No loop over people
-- or roles writes anything. Portable plain PostgreSQL (no vendor roles); runs on CI's vanilla postgres:16, on the
-- Render deploy, and possibly twice against the shared staging DB. NEVER run \`prisma migrate\` from a worktree.

DO $s01_22$
DECLARE
  rec record;
  planned bigint;
  missing bigint;
  logged bigint;
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  -- One-time data move of several hundred thousand rows: no statement timeout for this transaction only.
  PERFORM set_config('statement_timeout', '0', true);

${steps}
  -- Before writing: what each organization has, and what this run will do about it.
  FOR rec IN SELECT * FROM ${T}report WHERE role_rows_to_write > 0 OR people_changed > 0 OR custom_roles_translated > 0
                    OR dropped_grants > 0 OR overrides_ignored > 0 OR sales_unknown_shapes > 0 ORDER BY organization_id LOOP
    RAISE NOTICE 'S01.22 org %: role rows to write %, custom roles translated %, sales unknown shapes %, people filled %, people changed %, person rows to write %, log entries %, dropped grants %, overrides ignored %',
      rec.organization_id, rec.role_rows_to_write, rec.custom_roles_translated, rec.sales_unknown_shapes, rec.people_filled,
      rec.people_changed, rec.user_rows_to_write, rec.log_entries, rec.dropped_grants, rec.overrides_ignored;
  END LOOP;
  SELECT count(*) INTO planned FROM ${T}log_plan;
  RAISE NOTICE 'S01.22 totals: organizations %, role rows to write %, custom roles translated %, people filled %, person rows to write %, log entries %',
    (SELECT count(*) FROM ${T}report),
    (SELECT COALESCE(sum(role_rows_to_write), 0) FROM ${T}report),
    (SELECT COALESCE(sum(custom_roles_translated), 0) FROM ${T}report),
    (SELECT COALESCE(sum(people_filled), 0) FROM ${T}report),
    (SELECT COALESCE(sum(user_rows_to_write), 0) FROM ${T}report),
    planned;

  INSERT INTO permission_role_switches (id, organization_id, role_key, switch_key, value, created_at, updated_at)
  SELECT gen_random_uuid(), organization_id, role_key, switch_key, value, now(), now()
  FROM ${T}role_plan
  WHERE NOT stored
  ON CONFLICT (organization_id, role_key, switch_key) DO NOTHING;

  INSERT INTO permission_user_switches (id, organization_id, user_id, switch_key, value, created_at, updated_at)
  SELECT gen_random_uuid(), organization_id, user_id, switch_key, value, now(), now()
  FROM ${T}user_plan
  WHERE own_value IS DISTINCT FROM value
  ON CONFLICT (user_id, switch_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  UPDATE users u SET based_on_role_key = p.role_key
  FROM ${T}people p
  WHERE u.id = p.user_id AND u.based_on_role_key IS DISTINCT FROM p.role_key;

  INSERT INTO permission_change_log (id, organization_id, target_type, target_id, switch_key, from_value, to_value, actor_id, reason, created_at)
  SELECT gen_random_uuid(), organization_id, target_type, target_id, switch_key, from_value, to_value, NULL, 'migration', now()
  FROM ${T}log_plan;
  GET DIAGNOSTICS logged = ROW_COUNT;

  -- After writing: every planned row is there with its planned value, every person is based on their role, and the
  -- log holds what was planned. Anything else rolls the whole migration back.
  SELECT count(*) INTO missing FROM ${T}role_plan p
  WHERE NOT EXISTS (SELECT 1 FROM permission_role_switches s
                    WHERE s.organization_id = p.organization_id AND s.role_key = p.role_key AND s.switch_key = p.switch_key
                      AND (p.stored OR s.value = p.value));
  IF missing > 0 THEN
    RAISE EXCEPTION 'S01.22: % planned role rows did not land', missing;
  END IF;
  SELECT count(*) INTO missing FROM ${T}user_plan p
  WHERE NOT EXISTS (SELECT 1 FROM permission_user_switches s
                    WHERE s.user_id = p.user_id AND s.switch_key = p.switch_key AND s.value = p.value);
  IF missing > 0 THEN
    RAISE EXCEPTION 'S01.22: % planned person rows did not land', missing;
  END IF;
  SELECT count(*) INTO missing FROM ${T}people p
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id AND u.based_on_role_key = p.role_key);
  IF missing > 0 THEN
    RAISE EXCEPTION 'S01.22: % people were not based on their role', missing;
  END IF;
  IF logged <> planned THEN
    RAISE EXCEPTION 'S01.22: % of % planned log entries landed', logged, planned;
  END IF;
  RAISE NOTICE 'S01.22 proof: every planned row landed (% log entries)', logged;
END
$s01_22$;
`;
}

// ─── Reading the plan back out of the file (the dry run runs exactly this) ─────────────────────────

/** The steps of a migration file's plan, in order, as the SELECT each one is built from. */
export function planStepsFromSql(sql: string): Array<{ name: string; select: string }> {
  const steps: Array<{ name: string; select: string }> = [];
  const pattern = /-- @step (\S+)\n\s*CREATE TEMP TABLE \S+ ON COMMIT DROP AS\n([\s\S]*?);\n\s*-- @end/g;
  for (const m of sql.matchAll(pattern)) steps.push({ name: m[1]!, select: m[2]!.trim() });
  return steps;
}

/**
 * One read-only query that computes the plan and ends in the given SELECT, which may name any step (they carry the
 * `s01_22_` prefix). Nothing is created or written, so it can run inside a read-only transaction.
 */
export function planQuery(sql: string, finalSelect: string): string {
  const steps = planStepsFromSql(sql);
  return `WITH\n${steps.map((s) => `${s.name} AS (\n${s.select}\n)`).join(',\n')}\n${finalSelect}`;
}
