#!/usr/bin/env node
/**
 * Migration-shape proof for the preset acceptance (Roles & Permissions Overhaul, slice S07.24, PRD 7 "Migration").
 *
 * Question: do rows shaped like the production hand-made technician grants (organization-wide purchase-order read and
 * create, vendor read, logistic-order create, read and update, no condition) stop mattering once PRD 1's preset
 * migration (backend/prisma/migrations/20261012120000_permission_preset_migration) has run, and do the technicians of
 * that organization hold the Technician preset values?
 *
 * How: on a THROWAWAY local Postgres you start yourself, it creates a scratch database, applies every migration older
 * than the preset migration with psql, in order, seeds an organization with exactly those six rows plus two Technicians
 * (and a control organization with none), applies the real migration file with psql, then asserts from SQL:
 *   - every switch of every Technician equals the catalog's Technician preset (read from backend/src with tsx), in the
 *     hand-made organization exactly as in the control one;
 *   - the five switches the old rows used to grant are off, View logistic orders is on (the preset);
 *   - the Technician ROLE rows of that organization equal the preset too;
 *   - the six old rows are still in role_permissions (the migration reads them, never deletes them: they stay for
 *     rollback) and nothing at run time reads that table (a search of backend/src finds no reader), so they are gone
 *     in effect, not in the table;
 *   - a second run of the migration changes nothing.
 * Then it drops its scratch database. It never touches staging or production, and refuses a non-local server.
 *
 * Usage:
 *   initdb -D <dir named after your slice> -U postgres --auth=trust ; pg_ctl -D <dir> -o "-p <free port>" start
 *   node scripts/qa-rp-presets-migration-shape.mjs --pg-url postgresql://postgres@localhost:<port>/postgres
 *   (stop and delete only the server directory you started)
 * Exit code 1 when any check fails.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = `${REPO}/backend`;
const MIGRATIONS = `${BACKEND}/prisma/migrations`;
const PRESET_MIGRATION = '20261012120000_permission_preset_migration';

const flagValue = (name) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const serverUrl = flagValue('pg-url');
if (!serverUrl) die('usage: node scripts/qa-rp-presets-migration-shape.mjs --pg-url postgresql://postgres@localhost:<port>/postgres');
const server = new URL(serverUrl);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(server.hostname)) die(`refusing: ${server.hostname} is not a local server`);

const scratch = `qa_rp_s0724_${randomBytes(4).toString('hex')}`;
const urlFor = (db) => {
  const u = new URL(server.toString());
  u.pathname = `/${db}`;
  return u.toString();
};
const SCRATCH_URL = urlFor(scratch);

function psql(url, args) {
  const r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-At', '-F', '|', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed: ${String(r.stderr).trim().slice(0, 600)}`);
  return r.stdout.trim() === '' ? [] : r.stdout.trim().split('\n').map((l) => l.split('|'));
}
const sql = (text) => psql(SCRATCH_URL, ['-c', text]);
const applyFile = (file) => psql(SCRATCH_URL, ['-f', file]);

const results = [];
const check = (id, expected, got, ok) => results.push({ id, expected, got, ok: Boolean(ok) });

/** The catalog's Technician preset, straight from the source (no copy kept here). */
function technicianPreset() {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
    import('./src/lib/permissions/switches/catalog.ts').then((m) => {
      const out = {};
      for (const s of m.SWITCH_CATALOG) out[s.key] = s.presets.TECHNICIAN;
      console.log(JSON.stringify(out));
    });
  `], { cwd: BACKEND, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not read the catalog: ${String(r.stderr).slice(0, 300)}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
function newOrg(tag) {
  const id = randomUUID();
  sql(`INSERT INTO organizations (id, name, email, address_line1, city, state, postal_code, estimate_terms, estimate_notes, estimate_payment_terms, plan, updated_at)
       VALUES (${q(id)}, ${q(`org-${tag}`)}, ${q(`org-${tag}@example.test`)}, '1 Test Way', 'Testville', 'MA', '02108', '', '', '', 'SCALE', now())`);
  return id;
}
function newTechnician(org, name) {
  const id = randomUUID();
  sql(`INSERT INTO users (id, organization_id, email, first_name, last_name, role, is_active, updated_at)
       VALUES (${q(id)}, ${q(org)}, ${q(`${name}-${id.slice(0, 8)}@example.test`)}, ${q(name)}, 'Tester', 'TECHNICIAN'::"Role", true, now())`);
  return id;
}
function grant(org, role, action, subject) {
  sql(`INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, updated_at)
       VALUES (gen_random_uuid(), ${q(org)}, ${q(role)}, ${q(action)}, ${q(subject)}, NULL, now())`);
}

const personSet = (user) => Object.fromEntries(sql(`SELECT switch_key, value::text FROM permission_user_switches WHERE user_id = ${q(user)}`).map(([k, v]) => [k, JSON.parse(v)]));
const roleSet = (org) => Object.fromEntries(sql(`SELECT switch_key, value::text FROM permission_role_switches WHERE organization_id = ${q(org)} AND role_key = 'TECHNICIAN'`).map(([k, v]) => [k, JSON.parse(v)]));
const differences = (set, preset) => Object.keys(preset).filter((k) => JSON.stringify(set[k]) !== JSON.stringify(preset[k]));

// The six rows of the production hand-made technician grants, no condition on any.
const HAND_MADE = [
  ['read', 'PurchaseOrder'], ['create', 'PurchaseOrder'], ['read', 'Vendor'],
  ['create', 'LogisticOrder'], ['read', 'LogisticOrder'], ['update', 'LogisticOrder'],
];
// What those rows used to grant, as switches: they must be off for a Technician now (View logistic orders is on in the preset).
const WERE_GRANTED = ['view_purchase_orders', 'create_purchase_orders', 'view_vendors', 'create_logistic_orders', 'edit_logistic_orders'];

async function main() {
  const preset = technicianPreset();
  console.log(`\n  scratch database ${scratch} on the local server; ${Object.keys(preset).length} switches in the catalog`);
  psql(urlFor('postgres'), ['-c', `CREATE DATABASE ${scratch}`]);
  try {
    // 1. Every migration older than the preset migration, in order, as the deploy would apply them.
    const folders = readdirSync(MIGRATIONS).filter((d) => d < PRESET_MIGRATION && existsSync(`${MIGRATIONS}/${d}/migration.sql`)).sort();
    for (const d of folders) applyFile(`${MIGRATIONS}/${d}/migration.sql`);
    check('migrations before the preset migration apply', `${folders.length} applied`, `${folders.length} applied`, true);

    // 2. The starting point: an organization with the six hand-made rows and two Technicians, and a control organization.
    const handMadeOrg = newOrg('hand-made');
    const controlOrg = newOrg('control');
    for (const [action, subject] of HAND_MADE) grant(handMadeOrg, 'TECHNICIAN', action, subject);
    const techA = newTechnician(handMadeOrg, 'Alice');
    const techB = newTechnician(handMadeOrg, 'Bob');
    const controlTech = newTechnician(controlOrg, 'Carol');
    const before = Number(sql(`SELECT count(*) FROM role_permissions WHERE organization_id = ${q(handMadeOrg)} AND role = 'TECHNICIAN' AND conditions IS NULL AND (action, subject) IN (${HAND_MADE.map(([a, s]) => `(${q(a)}, ${q(s)})`).join(',')})`)[0][0]);
    check('fixture: the six hand-made rows exist, no condition', '6', String(before), before === 6);

    // 3. The real migration file, then again.
    applyFile(`${MIGRATIONS}/${PRESET_MIGRATION}/migration.sql`);
    const snapshot = () => JSON.stringify([personSet(techA), personSet(techB), personSet(controlTech), roleSet(handMadeOrg)]);
    const first = snapshot();

    // 4. What the fixture technicians hold now.
    for (const [label, user] of [['first technician of the hand-made organization', techA], ['second technician of the hand-made organization', techB], ['technician of the control organization', controlTech]]) {
      const set = personSet(user);
      const diff = differences(set, preset);
      check(`${label}: every switch holds the Technician preset`, `0 of ${Object.keys(preset).length} differ`, `${diff.length} differ${diff.length ? `: ${diff.slice(0, 6).join(', ')}` : ''}`, diff.length === 0 && Object.keys(set).length >= Object.keys(preset).length);
    }
    const set = personSet(techA);
    check('the switches the old rows granted are off', WERE_GRANTED.map((k) => `${k}=false`).join(' '), WERE_GRANTED.map((k) => `${k}=${set[k]}`).join(' '), WERE_GRANTED.every((k) => set[k] === false));
    check('View logistic orders is the preset value', `view_logistic_orders=${preset.view_logistic_orders}`, `view_logistic_orders=${set.view_logistic_orders}`, set.view_logistic_orders === preset.view_logistic_orders);
    const roleDiff = differences(roleSet(handMadeOrg), preset);
    check('the Technician role of that organization holds the preset', '0 differ', `${roleDiff.length} differ`, roleDiff.length === 0);
    const logged = Number(sql(`SELECT count(*) FROM permission_change_log WHERE organization_id = ${q(handMadeOrg)} AND reason = 'migration'`)[0][0]);
    check('change log for those technicians (information)', 'only values that changed are logged', `${logged} logged`, true);

    // 5. The old rows: kept for rollback, read by nobody.
    const after = Number(sql(`SELECT count(*) FROM role_permissions WHERE organization_id = ${q(handMadeOrg)} AND role = 'TECHNICIAN'`)[0][0]);
    check('the six old rows are still in role_permissions (kept for rollback)', '6', String(after), after === 6);
    const reader = spawnSync('git', ['grep', '-n', '-E', 'prisma\\.rolePermission\\.(find|count|aggregate)|FROM role_permissions', '--', 'backend/src', ':(exclude)**/__tests__/**', ':(exclude)backend/src/scripts', ':(exclude)backend/src/lib/permissions/switches/presetMigration.ts', ':(exclude)backend/src/lib/permissions/switches/presetMigrationReport.ts'], { cwd: REPO, encoding: 'utf8' });
    check('nothing at run time reads role_permissions', 'no reader in backend/src', reader.stdout.trim() === '' ? 'no reader' : reader.stdout.trim().split('\n').slice(0, 3).join(' | '), reader.stdout.trim() === '');

    // 6. A second run changes nothing.
    applyFile(`${MIGRATIONS}/${PRESET_MIGRATION}/migration.sql`);
    check('a second run of the migration changes nothing', 'same sets', snapshot() === first ? 'same sets' : 'sets changed', snapshot() === first);
  } finally {
    try { psql(urlFor('postgres'), ['-c', `DROP DATABASE IF EXISTS ${scratch}`]); } catch (err) { console.error(`  could not drop ${scratch}: ${err.message}`); }
  }
}

let crashed = null;
try {
  await main();
} catch (err) {
  crashed = err;
  console.error(`\n  the proof stopped: ${err.message}`);
}
console.log('\n  check                                                                          expected                           got                                   result');
for (const r of results) console.log(`  ${r.id.padEnd(78).slice(0, 78)} ${r.expected.padEnd(34).slice(0, 34)} ${r.got.padEnd(37).slice(0, 37)} ${r.ok ? 'PASS' : 'FAIL'}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length} checks, ${results.length - failed} passed, ${failed} failed\n`);
process.exit(crashed || failed ? 1 : 0);
