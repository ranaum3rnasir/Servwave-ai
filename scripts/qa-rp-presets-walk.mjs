#!/usr/bin/env node
/**
 * Preset acceptance walk on STAGING (Roles & Permissions Overhaul, slice S07.24, PRD 7).
 *
 * What it walks: PRD 7's section "Presets this PRD must make true", line by line, for four kinds of person on the
 * demo organization of the deployed staging app, as each person's own API session (the server's answer to the pages'
 * own data requests, and to a direct write attempt), plus a small browser pass (menu, job page, the two record
 * pages; console errors; no vendor or real customer name on screen; one screenshot each at desktop and 390 px):
 *
 *   technician  the BUILT-IN Technician role, no custom role
 *   dispatcher  the BUILT-IN Dispatcher role, no custom role
 *   sales       the BUILT-IN Sales role, no custom role
 *   approver    a person on a kept custom role that holds Approve logistic orders and is not the Admin preset
 *               (the kept "QA RP ..." roles are reused; a role is created only if none fits, and removed again)
 *   solo        a Dispatcher with Approve logistic orders switched on for that person: Create, Approve and Process
 *
 * Self-provisioning: every fixture (people, vendor, item with stock, warehouse, van, customer, jobs, lead, purchase
 * order, stages, assets, logistic orders) carries the run prefix "QA RP S0724 <run id>" (people: rp.s0724.<run>.<x>
 * @qa.servwave.test). Assertions are on the fixtures' own rows, never on global counts. Everything is removed again in
 * a finally block, also when a check fails.
 *
 * Usage (from any checkout; secrets come from backend/.env and frontend/.env of this checkout or of the main one):
 *   node scripts/qa-rp-presets-walk.mjs                    # provision, walk, browser pass, clean up
 *   node scripts/qa-rp-presets-walk.mjs --keep             # leave the fixtures in place for debugging
 *   node scripts/qa-rp-presets-walk.mjs --no-browser       # API walk only
 *   node scripts/qa-rp-presets-walk.mjs --cleanup <run id> # remove a crashed run's fixtures, found by prefix
 * Exit code 1 when any check fails. Prints a table: check, who, expected, got.
 * The migration half of the preset acceptance (rows shaped like the production hand-made technician grants) runs on a throwaway
 * local database: scripts/qa-rp-presets-migration-shape.mjs. Here, on staging, the technician, dispatcher and sales people are
 * compared switch by switch with the catalog's presets, and the old grants are shown to have no effect (C7).
 *
 * Guards: staging only, demo organization only (refuses unless /api/auth/me says org_is_demo and the id matches);
 * database writes go through psql, only to a host that carries the staging project ref, and only to rows that carry
 * the run prefix; the database URL, tokens and passwords are never printed. One request at a time (the hosted pool is
 * one connection). Every session it mints is signed out again by its own token (never a global sign-out).
 * No call, no text, no email. Not run by CI.
 */
import { createClient } from '@supabase/supabase-js';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORG = '00000000-0000-0000-0000-000000000001';
const API = 'https://alpha-crm-test-env.onrender.com';
const APP = 'https://servwave-demo.vercel.app';
const STAGING_REF = 'knriiqdqxgfoecsfarlx';
const EMAIL_SUFFIX = '@qa.servwave.test';
const ADMIN_EMAIL = 'admin@alphacrm.com';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const flagValue = (name) => (args.indexOf(`--${name}`) >= 0 ? args[args.indexOf(`--${name}`) + 1] : undefined);

// ─── Environment ──────────────────────────────────────────────────────────────

function readEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** The main checkout (a worktree's git common dir lives there); its .env files are the ones that exist. */
function mainCheckout() {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return resolve(REPO, common, '..');
  } catch {
    return REPO;
  }
}
const MAIN = mainCheckout();
const envFile = (rel) => {
  for (const root of [REPO, MAIN]) if (existsSync(`${root}/${rel}`)) return readEnv(`${root}/${rel}`);
  return {};
};

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const be = envFile('backend/.env');
const fe = envFile('frontend/.env');
if (!be.SUPABASE_URL || !be.SUPABASE_SERVICE_ROLE_KEY || !fe.VITE_SUPABASE_ANON_KEY || !be.DATABASE_URL) die('staging is not configured (backend/.env, frontend/.env)');
const DB_URL = be.DATABASE_URL.replace(/\?.*$/, '');
if (!DB_URL.includes(STAGING_REF)) die('refusing: DATABASE_URL does not name the staging project');
const sb = createClient(be.SUPABASE_URL, be.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const pub = createClient(be.SUPABASE_URL, fe.VITE_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const STORAGE_KEY = `sb-${new URL(be.SUPABASE_URL).hostname.split('.')[0]}-auth-token`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ─── Database (psql only, SELECT freely, writes only to the run's own rows) ─────

function psql(sql) {
  const r = spawnSync('psql', [DB_URL, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) {
    const text = String(r.stderr || r.error || '').split(DB_URL).join('<db>');
    throw new Error(`psql failed: ${text.trim().slice(0, 400)}`);
  }
  return r.stdout.trim() === '' ? [] : r.stdout.trim().split('\n').map((l) => l.split('|'));
}
const ids = (rows) => rows.map((r) => r[0]);
const NIL = '00000000-0000-0000-0000-000000000000';
const inList = (list) => (list.length ? list.map(sq).join(',') : sq(NIL));

// ─── Sessions (minted in memory under the shared lock, signed out by their own token) ──

const minted = []; // { email, token }
async function withMintLock(fn) {
  const dir = `${MAIN}/.qa`;
  mkdirSync(dir, { recursive: true });
  const lock = `${dir}/mint.lock`;
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() - t0 > 300_000) throw new Error('the session mint lock stayed busy for 5 minutes');
      await sleep(3000);
    }
  }
  try {
    return await fn();
  } finally {
    try { rmdirSync(lock); } catch { /* released by someone else */ }
  }
}

async function mint(email) {
  return withMintLock(async () => {
    const { data: link, error } = await sb.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) throw new Error(`generate_link failed for ${email}: ${error.message}`);
    const { data, error: otpErr } = await pub.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
    if (otpErr) throw new Error(`verifyOtp failed for ${email}: ${otpErr.message}`);
    minted.push({ email, token: data.session.access_token });
    return data.session;
  });
}

/** Sign out the sessions this run minted, each by its own token (never a global sign-out); `only` limits it to some people. */
async function signOutMinted(only) {
  let n = 0;
  for (const entry of minted.filter((m) => !only || only(m.email))) {
    minted.splice(minted.indexOf(entry), 1);
    try {
      const { error } = await sb.auth.admin.signOut(entry.token, 'local');
      if (!error) n++;
    } catch { /* already gone */ }
  }
  return n;
}

// ─── API client ───────────────────────────────────────────────────────────────

class Person {
  constructor(key, email) {
    this.key = key;
    this.email = email;
    this.id = null;
    this.session = null;
  }
  async login() {
    this.session = await mint(this.email);
  }
  /** One request; a 401 means the token expired, so sign in again once. */
  async call(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.session) await this.login();
      let res;
      try {
        res = await fetch(`${API}${path}`, {
          method,
          headers: { Authorization: `Bearer ${this.session.access_token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        return { status: 0, body: { error: String(err.message ?? err) } };
      }
      if (res.status === 401 && attempt === 0) {
        this.session = null;
        continue;
      }
      const text = await res.text();
      let json;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
      await sleep(120);
      return { status: res.status, body: json };
    }
    return { status: 401, body: null };
  }
  get = (path) => this.call('GET', path);
  post = (path, body) => this.call('POST', path, body ?? {});
  put = (path, body) => this.call('PUT', path, body);
  patch = (path, body) => this.call('PATCH', path, body);
  del = (path) => this.call('DELETE', path);
}

// ─── Run identity ─────────────────────────────────────────────────────────────

const RUN = flagValue('cleanup') ?? randomBytes(3).toString('hex');
if (!/^[0-9a-f]{6}$/.test(RUN)) die('the run id is six hex characters');
const PREFIX = `QA RP S0724 ${RUN}`;
const emailOf = (x) => `rp.s0724.${RUN}.${x}${EMAIL_SUFFIX}`;
const STATE_FILE = `${REPO}/.qa/rp-s0724-${RUN}.state.json`;

// ─── Report ───────────────────────────────────────────────────────────────────

const rows = [];
/** Record one check: criterion, id, who, what the PRD says, what came back, whether they agree. */
function ck(criterion, id, who, expected, got, ok) {
  rows.push({ criterion, id, who, expected: String(expected), got: String(got), ok: Boolean(ok) });
}
const showStatus = (r) => `${r.status}${r.body && typeof r.body === 'object' && (r.body.error || r.body.message) ? ` ${String(r.body.error ?? r.body.message).slice(0, 60)}` : ''}`;
/** A write or a page's data the person's switches do not allow: the route table answers 403. */
function refused(criterion, id, who, label, r) {
  ck(criterion, id, who, `${label}: 403`, showStatus(r), r.status === 403);
}
/** A record outside the person's reach: the route table answers 404, as if it did not exist. */
function hidden(criterion, id, who, label, r) {
  ck(criterion, id, who, `${label}: 404`, showStatus(r), r.status === 404);
}
function allowed(criterion, id, who, label, r) {
  ck(criterion, id, who, `${label}: 2xx`, showStatus(r), r.status >= 200 && r.status < 300);
}
const COST_KEY = /cost|margin|markup|profit|inventory_?value|account_?number|unit_?spend/i;
/** Every key in an answer whose name carries cost, margin or supplier money. */
function costKeys(value, path = '', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => costKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (COST_KEY.test(k)) out.push(`${path}.${k}`);
      costKeys(v, `${path}.${k}`, out);
    }
  }
  return out;
}
const firstOf = (body, ...keys) => {
  for (const k of keys) if (body && body[k] !== undefined) return body[k];
  return body;
};

// ─── The menu, as the app draws it (frontend/src/components/layout/nav-registry.ts) ──
// An entry shows when its View and Show switches are both on; the Logistic Orders child gives way to Stock; the
// Inventory heading shows when at least one child shows. The browser pass reads the real menu from the page.

function inventoryMenu(v) {
  const on = (view, show) => v[view] === true && v[show] === true;
  const stock = on('view_stock', 'show_stock_page');
  const children = [
    stock && 'Stock',
    on('view_price_book', 'show_price_book_page') && 'Price Book',
    on('view_purchase_orders', 'show_purchase_orders_page') && 'Purchase Orders',
    on('view_vendors', 'show_vendors_page') && 'Vendors',
    !stock && on('view_logistic_orders', 'show_logistic_orders_page') && 'Logistic Orders',
  ].filter(Boolean);
  return { heading: children.length > 0, children };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const F = { people: {}, roleCreated: null };
const saveState = () => {
  mkdirSync(`${REPO}/.qa`, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ run: RUN, prefix: PREFIX, org: ORG, ...F, people: Object.fromEntries(Object.entries(F.people).map(([k, p]) => [k, { email: p.email, id: p.id }])) }, null, 2));
};

/** A far-future slot for a job's one visit, so no fixture collides with real scheduling. */
const SLOT = { scheduled_start: '2027-03-02T14:00:00.000Z', scheduled_end: '2027-03-02T16:00:00.000Z' };
const SLOT2 = { scheduled_start: '2027-03-03T14:00:00.000Z', scheduled_end: '2027-03-03T16:00:00.000Z' };

async function provision(admin) {
  const fail = (what, r) => { throw new Error(`provisioning failed at ${what}: ${showStatus(r)}`); };

  // The approver's role: a kept custom role that holds Approve logistic orders, can see the jobs, is not the Admin preset.
  const roles = await admin.get('/api/roles');
  if (roles.status !== 200) fail('roles list', roles);
  let approverRole = null;
  for (const r of roles.body.filter((x) => x.type === 'custom' && x.base_role !== 'ADMIN' && /^QA RP/i.test(x.label))) {
    const set = await admin.get(`/api/roles/${encodeURIComponent(r.role)}/permissions`);
    const v = set.body?.values ?? {};
    if (set.status === 200 && v.approve_logistic_orders === true && v.view_logistic_orders === true && v.view_jobs === true && v.jobs_scope === 'all') {
      approverRole = r;
      break;
    }
  }
  if (!approverRole) {
    const made = await admin.post('/api/roles', { label: `${PREFIX} Approver`, base_role: 'DISPATCHER' });
    if (made.status !== 201 && made.status !== 200) fail('create approver role', made);
    F.roleCreated = made.body.role ?? made.body.key ?? made.body.id;
    const put = await admin.put(`/api/roles/${encodeURIComponent(F.roleCreated)}/permissions`, { values: { approve_logistic_orders: true, create_logistic_orders: false, process_logistic_orders: false } });
    if (put.status !== 200) fail('set approver role switches', put);
    const all = await admin.get('/api/roles');
    approverRole = all.body.find((x) => x.role === F.roleCreated);
  }
  F.approverRole = { key: approverRole.role, id: approverRole.id, base: approverRole.base_role, label: approverRole.label };
  saveState();

  // People. Built-in roles for technician, dispatcher, sales and solo; the kept custom role for the approver.
  const specs = [
    ['tech', 'TECHNICIAN', null, 'Technician'],
    ['disp', 'DISPATCHER', null, 'Dispatcher'],
    ['sales', 'SALES', null, 'Sales'],
    ['approver', F.approverRole.base, F.approverRole.id, 'Approver'],
    ['solo', 'DISPATCHER', null, 'Solo'],
  ];
  for (const [key, role, customRoleId, last] of specs) {
    const p = new Person(key, emailOf(key));
    const r = await admin.post('/api/users', {
      email: p.email, password: randomBytes(24).toString('base64url'), first_name: PREFIX, last_name: last, role,
      ...(customRoleId ? { custom_role_id: customRoleId } : {}),
    });
    if (r.status !== 201 && r.status !== 200) fail(`create ${key}`, r);
    p.id = r.body.user.id;
    p.name = `${PREFIX} ${last}`;
    F.people[key] = p;
    saveState();
  }
  // The solo person holds Create, Approve and Process: the Dispatcher preset plus Approve, set on that person alone.
  const solo = await admin.put(`/api/users/${F.people.solo.id}/permissions`, { values: { approve_logistic_orders: true } });
  if (solo.status !== 200) fail('solo person switch', solo);

  // Supplier, item with stock, warehouse and a van for the technician.
  const vendor = await admin.post('/api/inventory/vendors', { name: `${PREFIX} Vendor`, contactPersonName: 'QA Contact', contactEmail: 'delivered@resend.dev', accountNumber: 'ACCT-0724', status: 'active' });
  if (vendor.status >= 300) fail('vendor', vendor);
  F.vendorId = vendor.body.vendor.id;
  const item = await admin.post('/api/price-book/items', {
    name: `${PREFIX} Item`, sku: `QARPS0724-${RUN}`, unit_price: 25, unit_cost: 12.34, kind: 'material', track_inventory: true, vendor_id: F.vendorId, uom: 'ea',
  });
  if (item.status >= 300) fail('item', item);
  F.itemId = (item.body.data ?? item.body).id;
  const wh = await admin.post('/api/inventory/locations', { name: `${PREFIX} Warehouse`, type: 'warehouse' });
  if (wh.status >= 300) fail('warehouse', wh);
  F.warehouseId = wh.body.location.id;
  const van = await admin.post('/api/inventory/locations', { name: `${PREFIX} Van`, type: 'truck', primary_tech_id: F.people.tech.id });
  if (van.status >= 300) fail('van', van);
  F.vanId = van.body.location.id;
  saveState();
  const restock = await admin.post('/api/inventory/restock', { itemId: F.itemId, locationId: F.warehouseId, qty: 50, unitCost: 12.34, source: 'qa' });
  if (restock.status >= 300) fail('restock', restock);

  // A customer with two jobs (the technician is on the first only), a lead owned by the sales person.
  const j1 = await admin.post('/api/jobs', {
    new_customer: {
      first_name: PREFIX, last_name: 'Customer', email: `delivered+s0724${RUN}@resend.dev`,
      location: { address_line1: '1 QA RP S0724 Way', city: 'Albany', state: 'NY', zip: '12207' },
    },
    scope_notes: `${PREFIX} job one`, ...SLOT,
  });
  if (j1.status >= 300) fail('job one', j1);
  const job1 = j1.body.job ?? j1.body;
  F.job1 = { id: job1.id, number: job1.job_number };
  F.customerId = job1.customer_id ?? job1.customer?.id;
  F.locationId = job1.service_location_id ?? job1.service_location?.id;
  saveState();
  const j2 = await admin.post('/api/jobs', { customer_id: F.customerId, service_location_id: F.locationId, scope_notes: `${PREFIX} job two`, ...SLOT2 });
  if (j2.status >= 300) fail('job two', j2);
  const job2 = j2.body.job ?? j2.body;
  F.job2 = { id: job2.id, number: job2.job_number };
  saveState();
  const crew = await admin.post(`/api/jobs/${F.job1.id}/assign`, { assignee_ids: [F.people.tech.id], ...SLOT });
  if (crew.status >= 300) fail('put the technician on job one', crew);

  const lead = await admin.post('/api/leads', { customer_id: F.customerId, service_request: `${PREFIX} lead`, assigned_to: F.people.sales.id });
  if (lead.status >= 300) fail('lead', lead);
  const ld = lead.body.lead ?? lead.body;
  F.lead = { id: ld.id, number: ld.lead_number };
  saveState();

  // A job that comes from the sales person's own lead (Sales reaches jobs through its own leads): an estimate on the lead,
  // sent, approved in house, its deposit waived, then the job. The purchase order below hangs on it, so Sales can open it.
  const est = await admin.post('/api/estimates', {
    lead_id: F.lead.id, scope_notes: `${PREFIX} estimate`,
    line_items: [{ description: `${PREFIX} line`, quantity: 1, unit_price: 100 }],
  });
  if (est.status >= 300) fail('estimate on the lead', est);
  F.estimateId = est.body.estimate.id;
  saveState();
  for (const [what, r] of [
    ['mark the estimate sent', await admin.post(`/api/estimates/${F.estimateId}/mark-sent`, {})],
    ['approve the estimate in house', await admin.post(`/api/estimates/${F.estimateId}/approve-internal`, {})],
    ['waive the deposit', await admin.post(`/api/estimates/${F.estimateId}/waive-deposit`, {})],
  ]) if (r.status >= 300) fail(what, r);
  const j3 = await admin.post('/api/jobs', { estimate_id: F.estimateId, scope_notes: `${PREFIX} job three` });
  if (j3.status >= 300) fail('job from the lead', j3);
  F.job3 = { id: (j3.body.job ?? j3.body).id, number: (j3.body.job ?? j3.body).job_number };
  saveState();

  // A purchase order linked to job three (the dispatcher opens it as a linked record; Sales reaches it through its lead).
  const po = await admin.post('/api/inventory/purchase-orders', {
    vendorId: F.vendorId, jobId: F.job3.id, jobNumber: F.job3.number, customer: `${PREFIX} Customer`, site: '1 QA RP S0724 Way', notes: PREFIX,
    lines: [{ itemSku: `QARPS0724-${RUN}`, itemName: `${PREFIX} Item`, uom: 'ea', qtyOrdered: 2, unitCost: 12.34, priceBookItemId: F.itemId }],
  });
  if (po.status >= 300) fail('purchase order', po);
  F.poId = (po.body.purchaseOrder ?? po.body).id;
  saveState();

  // Four stages. s1: job one, assigned to the technician. s3: job two (technician not on it), assigned to the technician.
  // s2: job two, assigned to the dispatcher. s4: job one, nobody assigned.
  const stage = async (name, job, tech) => {
    const r = await admin.post('/api/inventory/job-stages', {
      jobId: job.id, jobNumber: job.number, customer: `${PREFIX} Customer`, site: `${PREFIX} ${name}`, trade: 'general', status: 'ready_for_pickup',
      stagedLocationId: F.warehouseId, ...(tech ? { assignedTechId: tech.id, assignedTech: tech.name } : {}),
      items: [{ itemSku: `QARPS0724-${RUN}`, itemName: `${PREFIX} Item`, uom: 'ea', qtyOrdered: 1, qtyReceived: 0, unitCost: 12.34, vendor: `${PREFIX} Vendor` }],
    });
    if (r.status >= 300) fail(`stage ${name}`, r);
    return (r.body.jobStage ?? r.body).id;
  };
  F.stages = {
    s1: await stage('s1', F.job1, F.people.tech),
    s2: await stage('s2', F.job2, F.people.disp),
    s3: await stage('s3', F.job2, F.people.tech),
    s4: await stage('s4', F.job1, null),
  };
  saveState();

  // Two assets: one held by the technician, one by the dispatcher.
  const mkAsset = async (name, holder) => {
    const a = await admin.post('/api/inventory/assets', { name: `${PREFIX} ${name}`, serial: `S0724-${RUN}-${name}` });
    if (a.status >= 300) fail(`asset ${name}`, a);
    const id = (a.body.asset ?? a.body).id;
    const as = await admin.post(`/api/inventory/assets/${id}/assign`, { user_id: holder.id });
    if (as.status >= 300) fail(`assign asset ${name}`, as);
    return id;
  };
  F.assets = { held: await mkAsset('Drill', F.people.tech), other: await mkAsset('Saw', F.people.disp) };
  saveState();

  // A draft order on job two, which the technician is not on (he must never see it).
  const o4 = await admin.post('/api/logistic-orders', { job_id: F.job2.id, lines: [{ item_id: F.itemId, qty: 1, from_location_id: F.warehouseId }], notes: PREFIX });
  if (o4.status >= 300) fail('order on job two', o4);
  F.orderJob2 = o4.body.id;
  saveState();
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/** Remove everything that carries the run prefix, in dependency order. Never throws; says what it could not remove. */
async function cleanup(admin) {
  const left = [];
  const step = async (label, fn) => {
    try { await fn(); } catch (err) { left.push(`${label}: ${String(err.message ?? err).slice(0, 160)}`); }
  };
  const like = `${PREFIX}%`;
  const users = ids(psql(`select id from users where organization_id=${sq(ORG)} and email like ${sq(`rp.s0724.${RUN}.%${EMAIL_SUFFIX}`)}`));
  const customers = ids(psql(`select id from customers where organization_id=${sq(ORG)} and first_name like ${sq(like)}`));
  const jobs = customers.length ? ids(psql(`select id from jobs where organization_id=${sq(ORG)} and customer_id in (${inList(customers)})`)) : [];
  const leads = customers.length ? ids(psql(`select id from leads where organization_id=${sq(ORG)} and customer_id in (${inList(customers)})`)) : [];
  const items = ids(psql(`select id from price_book_items where organization_id=${sq(ORG)} and name like ${sq(like)}`));
  const orders = ids(psql(`select id from logistic_orders where organization_id=${sq(ORG)} and (created_by in (${inList(users)}) or job_id in (${inList(jobs)}) or lead_id in (${inList(leads)}) or notes like ${sq(like)})`));
  const estimates = ids(psql(`select id from estimates where organization_id=${sq(ORG)} and (lead_id in (${inList(leads)}) or customer_id in (${inList(customers)}))`));
  const pos = ids(psql(`select id from purchase_orders where organization_id=${sq(ORG)} and (notes like ${sq(like)} or job_id in (${inList(jobs)}))`));
  const assets = ids(psql(`select id from assets where organization_id=${sq(ORG)} and name like ${sq(like)}`));
  const stageIds = ids(psql(`select id from job_stages where organization_id=${sq(ORG)} and customer like ${sq(like)}`));

  // Through the app first, so stock goes back and the app's own rules run: orders (a processed one returns its stock),
  // purchase orders, assets, jobs, the lead.
  for (const id of orders) await step(`order ${id}`, async () => { const r = await admin.del(`/api/logistic-orders/${id}`); if (r.status >= 300 && r.status !== 404) throw new Error(showStatus(r)); });
  for (const id of pos) await step(`purchase order ${id}`, async () => { const r = await admin.del(`/api/inventory/purchase-orders/${id}`); if (r.status >= 300 && r.status !== 404) throw new Error(showStatus(r)); });
  for (const id of assets) await step(`asset ${id}`, async () => { const r = await admin.del(`/api/inventory/assets/${id}`); if (r.status >= 300 && r.status !== 404) throw new Error(showStatus(r)); });
  for (const id of jobs) await step(`job ${id}`, async () => { const r = await admin.del(`/api/jobs/${id}`); if (r.status >= 300 && r.status !== 404) throw new Error(showStatus(r)); });
  // The app cannot delete a won estimate, so its rows go by SQL: its voided deposit invoice (waiving the deposit left one),
  // its send settings and the estimate itself (its lines and versions go with it).
  if (estimates.length) {
    await step('estimates', async () => {
      const inv = ids(psql(`select id from invoices where estimate_id in (${inList(estimates)}) and status='VOIDED'`));
      if (inv.length) {
        psql(`delete from invoice_line_items where invoice_id in (${inList(inv)})`);
        psql(`delete from invoices where id in (${inList(inv)}) and organization_id=${sq(ORG)}`);
      }
      psql(`delete from estimate_send_configs where estimate_id in (${inList(estimates)})`);
      psql(`delete from estimates where id in (${inList(estimates)}) and organization_id=${sq(ORG)}`);
    });
  }
  for (const id of leads) await step(`lead ${id}`, async () => { const r = await admin.del(`/api/leads/${id}`); if (r.status >= 300 && r.status !== 404) throw new Error(showStatus(r)); });

  // The rest by SQL, scoped to the run's own rows (the app has no delete for a stage, and an item with stock history is archived, not removed).
  await step('stages', async () => {
    const stages = ids(psql(`select id from job_stages where organization_id=${sq(ORG)} and customer like ${sq(like)}`));
    if (!stages.length) return;
    for (const t of ['stage_audit_entries', 'job_stage_attachments', 'job_stage_lines']) psql(`delete from ${t} where job_stage_id in (${inList(stages)})`);
    psql(`delete from job_stages where id in (${inList(stages)})`);
  });
  await step('stock', async () => {
    if (!items.length) return;
    const lines = ids(psql(`select id from logistic_order_lines where item_id in (${inList(items)})`));
    if (lines.length) {
      psql(`delete from stock_movements where logistic_order_line_id in (${inList(lines)})`);
      psql(`delete from logistic_order_lines where id in (${inList(lines)})`);
    }
    psql(`delete from stock_movements where organization_id=${sq(ORG)} and item_id in (${inList(items)})`);
    psql(`delete from stock_balances where organization_id=${sq(ORG)} and item_id in (${inList(items)})`);
  });
  await step('purchase order rows', async () => {
    const left2 = ids(psql(`select id from purchase_orders where organization_id=${sq(ORG)} and notes like ${sq(like)}`));
    if (!left2.length) return;
    psql(`delete from purchase_order_lines where purchase_order_id in (${inList(left2)})`);
    psql(`delete from purchase_orders where id in (${inList(left2)})`);
  });
  await step('assets rows', async () => {
    const a = ids(psql(`select id from assets where organization_id=${sq(ORG)} and name like ${sq(like)}`));
    if (!a.length) return;
    psql(`delete from asset_events where asset_id in (${inList(a)})`);
    psql(`delete from assets where id in (${inList(a)})`);
  });
  await step('items', async () => {
    if (items.length) psql(`delete from price_book_items where organization_id=${sq(ORG)} and id in (${inList(items)})`);
  });
  await step('locations', async () => psql(`delete from inventory_locations where organization_id=${sq(ORG)} and name like ${sq(like)}`));
  await step('vendors', async () => {
    const v = ids(psql(`select id from vendors where organization_id=${sq(ORG)} and name like ${sq(like)}`));
    if (!v.length) return;
    psql(`delete from vendor_contacts where vendor_id in (${inList(v)})`);
    psql(`delete from vendors where id in (${inList(v)})`);
  });
  // Alerts the walk raised: about the run's orders, jobs, leads and people, or raised by the run's people.
  await step('notifications', async () => {
    const subjects = [...orders, ...jobs, ...leads, ...users, ...customers, ...assets, ...estimates, ...stageIds, ...pos, ...items];
    const n = ids(psql(`select id from notifications where organization_id=${sq(ORG)} and (object_id in (${inList(subjects)}) or actor_id in (${inList(users)}) or object_label like ${sq(like)} or title like ${sq(like)} or body like ${sq(like)} or data::text like ${sq(`%${PREFIX}%`)})`));
    if (!n.length) return;
    psql(`delete from notification_recipients where notification_id in (${inList(n)})`);
    psql(`delete from notifications where id in (${inList(n)})`);
  });
  for (const id of customers) await step(`customer ${id}`, async () => {
    const r = await admin.del(`/api/customers/${id}`);
    if (r.status >= 300 && r.status !== 404) throw new Error(showStatus(r));
  });
  // People: deactivate, then delete for good; a person with history stays deactivated and the run says so.
  for (const id of users) {
    await step(`user ${id}`, async () => {
      await admin.del(`/api/users/${id}`);
      const r = await admin.del(`/api/users/${id}/permanent`);
      if (r.status >= 300 && r.status !== 404) throw new Error(`kept deactivated: ${showStatus(r)}`);
    });
  }
  // A role this run had to create (the kept roles are never touched): archive it, then remove its rows.
  await step('role', async () => {
    const roleRows = psql(`select id, key from custom_roles where organization_id=${sq(ORG)} and label like ${sq(like)}`);
    for (const [id, key] of roleRows) {
      psql(`delete from permission_role_switches where organization_id=${sq(ORG)} and role_key=${sq(key)}`);
      psql(`delete from custom_roles where id=${sq(id)}`);
    }
  });
  try { unlinkSync(STATE_FILE); } catch { /* none */ }
  return left;
}

/** Whatever carries the run prefix and is still in the database, by table. */
function leftovers() {
  const like = `${PREFIX}%`;
  const q = (label, sql) => [label, Number(psql(sql)[0]?.[0] ?? 0)];
  const e = sq(`rp.s0724.${RUN}.%`);
  const found = [
    q('users', `select count(*) from users where email like ${e}`),
    q('custom roles', `select count(*) from custom_roles where label like ${sq(like)}`),
    q('customers', `select count(*) from customers where first_name like ${sq(like)}`),
    q('jobs', `select count(*) from jobs where scope_notes like ${sq(like)}`),
    q('leads', `select count(*) from leads where service_request like ${sq(like)}`),
    q('estimates', `select count(*) from estimates where scope_notes like ${sq(like)}`),
    q('logistic orders', `select count(*) from logistic_orders where notes like ${sq(like)}`),
    q('purchase orders', `select count(*) from purchase_orders where notes like ${sq(like)}`),
    q('items', `select count(*) from price_book_items where name like ${sq(like)}`),
    q('stock rows', `select count(*) from stock_balances b join price_book_items i on i.id=b.item_id where i.name like ${sq(like)}`),
    q('vans and warehouses', `select count(*) from inventory_locations where name like ${sq(like)}`),
    q('vendors', `select count(*) from vendors where name like ${sq(like)}`),
    q('stages', `select count(*) from job_stages where customer like ${sq(like)}`),
    q('assets', `select count(*) from assets where name like ${sq(like)}`),
    q('notifications', `select count(*) from notifications where title like ${sq(like)} or body like ${sq(like)} or object_label like ${sq(like)} or data::text like ${sq(`%${PREFIX}%`)}`),
  ];
  return found.filter(([, n]) => n > 0);
}

// ─── The walk ─────────────────────────────────────────────────────────────────

const has = (rules, action, subject) => rules.some((r) => !r.inverted && [].concat(r.action).includes(action) && [].concat(r.subject).includes(subject));
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const statusOf = (r) => r.body?.status;
const actionsOf = (r) => r.body?.actions ?? [];
const lineOf = (order) => ({ item_id: F.itemId, qty: 1, from_location_id: F.warehouseId });

/** Stock on hand of the fixture item in the fixture warehouse, read as the admin. */
async function onHand(admin) {
  const r = await admin.get(`/api/inventory/items/${F.itemId}`);
  return r.body?.item?.stock?.find((s) => s.locationId === F.warehouseId)?.onHand;
}

async function walk(admin) {
  await walkApi(admin);
  if (!flag('no-browser')) await browserPass(admin);
}

async function walkApi(admin) {
  const P = F.people;
  const mine = {};
  for (const [k, p] of Object.entries(P)) {
    await p.login();
    const r = await p.get('/api/permission-switches/me');
    if (r.status !== 200) throw new Error(`could not read ${k}'s switches: ${showStatus(r)}`);
    mine[k] = r.body;
  }
  F.mine = mine;
  const catalog = (await admin.get('/api/permission-switches/catalog')).body.switches;
  const T = P.tech, D = P.disp, S = P.sales, A = P.approver, SO = P.solo;
  const tv = mine.tech.values, dv = mine.disp.values, sv = mine.sales.values;
  const trules = mine.tech.rules, drules = mine.disp.rules, srules = mine.sales.rules;
  const stock0 = await onHand(admin);

  // ── The dispatcher builds the order that the rest of the walk reads (C2) ──────────────────────────────────
  const C2 = 'C2 dispatcher';
  const o1 = await D.post('/api/logistic-orders', { job_id: F.job1.id, lines: [lineOf()], notes: PREFIX });
  allowed(C2, 'create an order from the job', 'dispatcher', 'POST /api/logistic-orders on the job', o1);
  F.o1 = o1.body?.id;
  saveState();
  ck(C2, 'draft offers Submit, no Approve', 'dispatcher', 'actions has submit, not approve', actionsOf(o1).join(','), actionsOf(o1).includes('submit') && !actionsOf(o1).includes('approve'));
  const o1s = await D.post(`/api/logistic-orders/${F.o1}/submit`);
  ck(C2, 'submit', 'dispatcher', 'PENDING_APPROVAL', `${o1s.status} ${statusOf(o1s)}`, statusOf(o1s) === 'PENDING_APPROVAL');
  ck(C2, 'no Approve action on the order', 'dispatcher', 'approve not in actions', actionsOf(o1s).join(',') || '(none)', !actionsOf(o1s).includes('approve') && !actionsOf(o1s).includes('process'));
  refused(C2, 'approve by the dispatcher', 'dispatcher', 'POST approve', await D.post(`/api/logistic-orders/${F.o1}/approve`));
  const readerSees = await T.get(`/api/logistic-orders/${F.o1}`);

  // The alert: a notification row for the approver with the order-submitted verb (S07.9), read as the approver.
  let alert = null;
  for (let i = 0; i < 24 && !alert; i++) {
    const n = await A.get('/api/notifications?limit=100');
    alert = (n.body?.items ?? []).find((x) => x.verb === 'lo.submitted' && x.object_id === F.o1);
    if (!alert) await sleep(5000);
  }
  ck(C2, 'approver gets the order-submitted alert', 'approver', 'a lo.submitted notification for the order', alert ? `found, ${alert.title ?? ''}`.slice(0, 80) : 'none after 2 minutes', Boolean(alert));
  const techAlerts = (await T.get('/api/notifications?limit=100')).body?.items ?? [];
  ck(C2, 'a holder without Approve is not alerted', 'technician', 'no lo.submitted for the order', techAlerts.some((x) => x.verb === 'lo.submitted' && x.object_id === F.o1) ? 'alerted' : 'none', !techAlerts.some((x) => x.verb === 'lo.submitted' && x.object_id === F.o1));
  const sub = (await D.get('/api/notifications?limit=100')).body?.items ?? [];
  ck(C2, 'the submitter is not alerted', 'dispatcher', 'no lo.submitted for their own order', sub.some((x) => x.verb === 'lo.submitted' && x.object_id === F.o1) ? 'alerted' : 'none', !sub.some((x) => x.verb === 'lo.submitted' && x.object_id === F.o1));

  const appr = await A.post(`/api/logistic-orders/${F.o1}/approve`);
  ck(C2, 'approver approves', 'approver', 'APPROVED', `${appr.status} ${statusOf(appr)}`, statusOf(appr) === 'APPROVED');
  const seenApproved = await D.get(`/api/logistic-orders/${F.o1}`);
  ck(C2, 'process is offered after approval', 'dispatcher', 'process in actions', actionsOf(seenApproved).join(','), actionsOf(seenApproved).includes('process') && !actionsOf(seenApproved).includes('approve'));
  const proc = await D.post(`/api/logistic-orders/${F.o1}/process`);
  allowed(C2, 'dispatcher processes it', 'dispatcher', 'POST process', proc);
  const after1 = await onHand(admin);
  ck(C2, 'stock taken by processing', 'dispatcher', `fixture warehouse ${stock0} -> ${stock0 - 1}`, `${stock0} -> ${after1}`, after1 === stock0 - 1);
  const o1p = await D.get(`/api/logistic-orders/${F.o1}`);
  ck(C2, 'processed order offers both pickup buttons', 'dispatcher', 'pick_up and record_pickup in actions', actionsOf(o1p).join(','), actionsOf(o1p).includes('pick_up') && actionsOf(o1p).includes('record_pickup'));

  // ── C3: Create, Approve and Process on one person: draft to processed alone ────────────────────────────────
  const C3 = 'C3 solo (Create+Approve+Process)';
  const sv3 = mine.solo.values;
  ck(C3, 'the three switches are on', 'solo', 'create, approve, process = true', `${sv3.create_logistic_orders}, ${sv3.approve_logistic_orders}, ${sv3.process_logistic_orders}`, sv3.create_logistic_orders === true && sv3.approve_logistic_orders === true && sv3.process_logistic_orders === true);
  const o2 = await SO.post('/api/logistic-orders', { job_id: F.job1.id, lines: [lineOf()], notes: PREFIX });
  F.o2 = o2.body?.id;
  ck(C3, 'create', 'solo', 'DRAFT', `${o2.status} ${statusOf(o2)}`, statusOf(o2) === 'DRAFT');
  const o2s = await SO.post(`/api/logistic-orders/${F.o2}/submit`);
  ck(C3, 'submit', 'solo', 'PENDING_APPROVAL', `${o2s.status} ${statusOf(o2s)}`, statusOf(o2s) === 'PENDING_APPROVAL');
  ck(C3, 'Approve offered on own order', 'solo', 'approve in actions', actionsOf(o2s).join(','), actionsOf(o2s).includes('approve'));
  const o2a = await SO.post(`/api/logistic-orders/${F.o2}/approve`);
  ck(C3, 'approve', 'solo', 'APPROVED', `${o2a.status} ${statusOf(o2a)}`, statusOf(o2a) === 'APPROVED');
  const o2p = await SO.post(`/api/logistic-orders/${F.o2}/process`);
  allowed(C3, 'process', 'solo', 'POST process', o2p);
  const o2r = await SO.get(`/api/logistic-orders/${F.o2}`);
  ck(C3, 'processed, alone', 'solo', 'PROCESSED', statusOf(o2r), statusOf(o2r) === 'PROCESSED');
  const after2 = await onHand(admin);
  ck(C3, 'stock taken by processing', 'solo', `warehouse ${after1} -> ${after1 - 1}`, `${after1} -> ${after2}`, after2 === after1 - 1);

  // ── C1: Technician ────────────────────────────────────────────────────────────────────────────────────────
  const C1 = 'C1 technician';
  const tm = inventoryMenu(tv);
  ck(C1, 'menu: Inventory heading, Stock and Price Book only', 'technician', 'heading with Stock, Price Book', `${tm.heading ? 'heading' : 'no heading'}: ${tm.children.join(', ')}`, tm.heading && sameList(tm.children, ['Stock', 'Price Book']));
  const titem = await T.get(`/api/inventory/items/${F.itemId}`);
  ck(C1, 'stock readable', 'technician', 'item answers with the warehouse quantity', `${titem.status} ${titem.body?.item?.stock?.length ?? 0} stock rows`, titem.status === 200 && (titem.body?.item?.stock ?? []).length > 0);
  ck(C1, 'no cost on the stock item', 'technician', 'no cost key', costKeys(titem.body).join(',') || 'none', costKeys(titem.body).length === 0);
  allowed(C1, 'low-stock list', 'technician', 'GET low-stock', await T.get('/api/inventory/low-stock'));
  const titems = await T.get('/api/inventory/items?limit=100');
  ck(C1, 'no cost on the stock list (no Inventory Value)', 'technician', '200, no cost key in any row', `${titems.status} ${costKeys(titems.body).slice(0, 3).join(',') || 'none'}`, titems.status === 200 && costKeys(titems.body).length === 0);
  refused(C1, 'restock', 'technician', 'POST restock', await T.post('/api/inventory/restock', { itemId: F.itemId, locationId: F.warehouseId, qty: 1 }));
  refused(C1, 'bulk restock', 'technician', 'POST bulk-restock', await T.post('/api/inventory/bulk-restock', { lines: [{ itemId: F.itemId, locationId: F.warehouseId, qty: 1 }] }));
  refused(C1, 'transfer', 'technician', 'POST transfer', await T.post('/api/inventory/transfer', { itemId: F.itemId, fromId: F.warehouseId, toId: F.vanId, qty: 1 }));
  refused(C1, 'count', 'technician', 'POST stock/set-quantity', await T.post('/api/inventory/stock/set-quantity', { itemId: F.itemId, locationId: F.warehouseId, newQty: 3 }));
  refused(C1, 'reserve levels', 'technician', 'PUT stock/thresholds', await T.put('/api/inventory/stock/thresholds', { itemId: F.itemId, locationId: F.warehouseId, min: 1, max: 5 }));
  refused(C1, 'new location', 'technician', 'POST locations', await T.post('/api/inventory/locations', { name: `${PREFIX} nope`, type: 'warehouse' }));
  refused(C1, 'Activity tab data', 'technician', 'GET movements', await T.get('/api/inventory/movements'));
  refused(C1, 'item movement history', 'technician', 'GET movements?item_id', await T.get(`/api/inventory/movements?item_id=${F.itemId}`));
  // own assets
  const tAssets = await T.get('/api/inventory/assets');
  const tAssetIds = (tAssets.body?.data ?? []).map((a) => a.id);
  ck(C1, 'own assets only', 'technician', 'the held asset, not the other one', `held ${tAssetIds.includes(F.assets.held)}, other ${tAssetIds.includes(F.assets.other)}`, tAssetIds.includes(F.assets.held) && !tAssetIds.includes(F.assets.other));
  hidden(C1, "a colleague's asset by link", 'technician', 'GET asset (not held)', await T.get(`/api/inventory/assets/${F.assets.other}`));
  refused(C1, 'asset write', 'technician', 'POST assets/:id/note', await T.post(`/api/inventory/assets/${F.assets.held}/note`, { note: 'x' }));
  refused(C1, 'asset create', 'technician', 'POST assets', await T.post('/api/inventory/assets', { name: `${PREFIX} nope` }));
  // scoped staging
  const tStages = await T.get('/api/inventory/job-stages');
  const tStageIds = (tStages.body?.jobStages ?? []).map((x) => x.id);
  ck(C1, 'staging: attached job, assigned stage', 'technician', 's1, s3, s4 shown; s2 (not his job, not his stage) hidden', `s1 ${tStageIds.includes(F.stages.s1)}, s3 ${tStageIds.includes(F.stages.s3)}, s4 ${tStageIds.includes(F.stages.s4)}, s2 ${tStageIds.includes(F.stages.s2)}`, tStageIds.includes(F.stages.s1) && tStageIds.includes(F.stages.s3) && tStageIds.includes(F.stages.s4) && !tStageIds.includes(F.stages.s2));
  hidden(C1, 'a stage out of reach by link', 'technician', 'GET job-stages/s2', await T.get(`/api/inventory/job-stages/${F.stages.s2}`));
  const lineKeys = (tStages.body?.jobStages ?? []).flatMap((x) => x.items ?? []).flatMap((l) => Object.keys(l));
  ck(C1, 'staging lines: no unit cost, no vendor', 'technician', 'no unitCost, no vendor key', lineKeys.filter((k) => /cost|vendor/i.test(k)).join(',') || 'none', !lineKeys.some((k) => /cost|vendor/i.test(k)));
  refused(C1, 'stage edit', 'technician', 'PATCH job-stages/s1', await T.patch(`/api/inventory/job-stages/${F.stages.s1}`, { notes: 'x' }));
  refused(C1, 'stage receive', 'technician', 'POST job-stages/receive', await T.post('/api/inventory/job-stages/receive', { stageId: F.stages.s1, lineId: F.itemId, qty: 1 }));
  refused(C1, 'stage notify', 'technician', 'POST job-stages/notify', await T.post('/api/inventory/job-stages/notify', { stageId: F.stages.s1 }));
  // Taken by me on an assigned stage; no Taken by...
  refused(C1, 'Taken by... picker (no Record pickup)', 'technician', 'GET pickup-people', await T.get(`/api/inventory/job-stages/${F.stages.s1}/pickup-people`));
  refused(C1, 'Taken by... on a stage', 'technician', 'POST taken-by', await T.post(`/api/inventory/job-stages/${F.stages.s1}/taken-by`, { takenById: D.id }));
  const mineTaken = await T.post(`/api/inventory/job-stages/${F.stages.s1}/taken-by-me`);
  const st1 = mineTaken.body?.jobStage;
  ck(C1, 'Taken by me on an assigned stage', 'technician', 'saved: taken by and recorded by the technician', `${mineTaken.status} takenBy ${st1?.takenByName ?? '-'}, recordedBy ${st1?.recordedByName ?? '-'}`, mineTaken.status === 200 && st1?.takenById === T.id && st1?.recordedById === T.id);
  const lastNote = (st1?.auditLog ?? []).at(-1)?.comment;
  ck(C1, 'the stage history reads "Taken by <technician>"', 'technician', `Taken by ${T.name}`, lastNote ?? '-', lastNote === `Taken by ${T.name}`);
  // logistic orders: only from the job, read only
  ck(C1, 'no Logistic Orders tab (Show switch off)', 'technician', 'show_logistic_orders_page false, View on', `show ${tv.show_logistic_orders_page}, view ${tv.view_logistic_orders}`, tv.show_logistic_orders_page === false && tv.view_logistic_orders === true);
  const tJobOrders = await T.get(`/api/logistic-orders?job_id=${F.job1.id}`);
  const tJobIds = (tJobOrders.body?.data ?? []).map((o) => o.id);
  ck(C1, "the job page lists the job's orders", 'technician', 'o1 and o2 listed', `o1 ${tJobIds.includes(F.o1)}, o2 ${tJobIds.includes(F.o2)}`, tJobIds.includes(F.o1) && tJobIds.includes(F.o2));
  const tAll = await T.get('/api/logistic-orders');
  ck(C1, 'orders on a job he is not on stay hidden', 'technician', 'the job-two order not listed', `listed ${(tAll.body?.data ?? []).some((o) => o.id === F.orderJob2)}`, !(tAll.body?.data ?? []).some((o) => o.id === F.orderJob2));
  hidden(C1, 'that order by link', 'technician', 'GET logistic-orders/:id', await T.get(`/api/logistic-orders/${F.orderJob2}`));
  ck(C1, 'read only: no action on a submitted order', 'technician', 'no actions', actionsOf(readerSees).join(',') || '(none)', readerSees.status === 200 && actionsOf(readerSees).length === 0);
  refused(C1, 'order create', 'technician', 'POST logistic-orders', await T.post('/api/logistic-orders', { job_id: F.job1.id, lines: [lineOf()] }));
  refused(C1, 'order edit', 'technician', 'PATCH logistic-orders/o1', await T.patch(`/api/logistic-orders/${F.o1}`, { notes: 'x' }));
  refused(C1, 'order submit', 'technician', 'POST submit', await T.post(`/api/logistic-orders/${F.o1}/submit`));
  refused(C1, 'order approve', 'technician', 'POST approve', await T.post(`/api/logistic-orders/${F.o1}/approve`));
  refused(C1, 'order process', 'technician', 'POST process', await T.post(`/api/logistic-orders/${F.o1}/process`));
  refused(C1, 'order cancel', 'technician', 'POST cancel', await T.post(`/api/logistic-orders/${F.o1}/cancel`, {}));
  refused(C1, 'order delete', 'technician', 'DELETE logistic-orders/o1', await T.del(`/api/logistic-orders/${F.o1}`));
  const tO2 = await T.get(`/api/logistic-orders/${F.o2}`);
  ck(C1, 'Processed order: only "Taken by me"', 'technician', 'pick_up, not record_pickup, nothing else', actionsOf(tO2).join(','), sameList(actionsOf(tO2), ['pick_up']));
  refused(C1, 'Taken by... on an order', 'technician', 'POST taken-by', await T.post(`/api/logistic-orders/${F.o2}/taken-by`, { takenById: D.id }));
  const tTake = await T.post(`/api/logistic-orders/${F.o2}/taken-by-me`);
  ck(C1, 'Taken by me on a Processed order', 'technician', 'taken by and recorded by the technician', `${tTake.status} ${tTake.body?.takenBy?.name ?? '-'} / ${tTake.body?.recordedBy?.name ?? '-'}`, tTake.status === 200 && tTake.body?.takenBy?.id === T.id && tTake.body?.recordedBy?.id === T.id);
  // price book
  const tpb = await T.get(`/api/price-book/items/${F.itemId}`);
  ck(C1, 'Price Book readable, no cost', 'technician', '200, no cost or margin key', `${tpb.status} ${costKeys(tpb.body).join(',') || 'none'}`, tpb.status === 200 && costKeys(tpb.body).length === 0);
  allowed(C1, 'Price Book list', 'technician', 'GET catalog-items', await T.get('/api/price-book/catalog-items?limit=5'));
  refused(C1, 'Price Book add', 'technician', 'POST price-book/items', await T.post('/api/price-book/items', { name: `${PREFIX} nope`, unit_price: 1 }));
  refused(C1, 'Price Book edit', 'technician', 'PATCH price-book/items/:id', await T.patch(`/api/price-book/items/${F.itemId}`, { name: `${PREFIX} nope` }));
  refused(C1, 'Price Book delete', 'technician', 'DELETE price-book/items/:id', await T.del(`/api/price-book/items/${F.itemId}`));
  refused(C1, 'Price Book category', 'technician', 'POST price-book/categories', await T.post('/api/price-book/categories', { name: `${PREFIX} nope` }));
  refused(C1, 'Price Book import', 'technician', 'POST price-book/items/import', await T.post('/api/price-book/items/import', { items: [] }));
  // the back office is closed
  refused(C1, 'Purchase Orders list', 'technician', 'GET purchase-orders', await T.get('/api/inventory/purchase-orders'));
  refused(C1, 'a purchase order by link', 'technician', 'GET purchase-orders/:id', await T.get(`/api/inventory/purchase-orders/${F.poId}`));
  refused(C1, 'purchase order create', 'technician', 'POST purchase-orders', await T.post('/api/inventory/purchase-orders', { vendorId: F.vendorId, lines: [{ itemName: 'x', uom: 'ea', qtyOrdered: 1 }] }));
  refused(C1, 'Create PO from a job', 'technician', 'POST purchase-orders/from-job', await T.post('/api/inventory/purchase-orders/from-job', { jobId: F.job1.id }));
  refused(C1, 'Vendors list', 'technician', 'GET vendors', await T.get('/api/inventory/vendors'));
  refused(C1, 'a vendor by link', 'technician', 'GET vendors/:id', await T.get(`/api/inventory/vendors/${F.vendorId}`));
  refused(C1, 'job material cost', 'technician', 'GET jobs/:id/material-cost', await T.get(`/api/inventory/jobs/${F.job1.id}/material-cost`));
  refused(C1, 'low-stock proposals (carry cost)', 'technician', 'GET purchase-orders/low-stock-proposals', await T.get('/api/inventory/purchase-orders/low-stock-proposals'));
  refused(C1, 'Service Plans', 'technician', 'GET service-plans', await T.get('/api/service-plans'));
  refused(C1, 'Automations', 'technician', 'GET workflows', await T.get('/api/workflows'));
  refused(C1, 'Billing (unpaid invoices)', 'technician', 'GET reports/ar-aging', await T.get('/api/reports/ar-aging'));
  refused(C1, 'Reports', 'technician', 'GET reports/jobs', await T.get('/api/reports/jobs'));
  refused(C1, 'Inventory usage report', 'technician', 'GET reports/inventory-usage', await T.get('/api/reports/inventory-usage'));
  ck(C1, 'Marketing is off (display only)', 'technician', 'access_marketing false', String(tv.access_marketing), tv.access_marketing === false);
  const tExports = ['Inventory', 'PriceBook', 'PurchaseOrder', 'Vendor', 'Report'].filter((s) => has(trules, 'export', s));
  ck(C1, 'no exports', 'technician', 'no export rule on any inventory subject or reports', tExports.join(',') || 'none', tExports.length === 0);

  // ── C2 continued: the dispatcher's own surfaces ───────────────────────────────────────────────────────────
  const dm = inventoryMenu(dv);
  ck(C2, 'menu: Price Book only', 'dispatcher', 'heading with Price Book only', `${dm.heading ? 'heading' : 'no heading'}: ${dm.children.join(', ')}`, dm.heading && sameList(dm.children, ['Price Book']));
  ck(C2, 'Stock, Purchase Orders, Vendors, Logistic Orders lists hidden', 'dispatcher', 'all four Show switches off', `stock ${dv.show_stock_page}, po ${dv.show_purchase_orders_page}, vendors ${dv.show_vendors_page}, orders ${dv.show_logistic_orders_page}`, [dv.show_stock_page, dv.show_purchase_orders_page, dv.show_vendors_page, dv.show_logistic_orders_page].every((x) => x === false));
  const dpb = await D.get(`/api/price-book/items/${F.itemId}`);
  ck(C2, 'Price Book readable, no cost', 'dispatcher', '200, no cost or margin key', `${dpb.status} ${costKeys(dpb.body).join(',') || 'none'}`, dpb.status === 200 && costKeys(dpb.body).length === 0);
  refused(C2, 'Price Book add', 'dispatcher', 'POST price-book/items', await D.post('/api/price-book/items', { name: `${PREFIX} nope`, unit_price: 1 }));
  refused(C2, 'Price Book edit', 'dispatcher', 'PATCH price-book/items/:id', await D.patch(`/api/price-book/items/${F.itemId}`, { name: `${PREFIX} nope` }));
  refused(C2, 'Price Book delete', 'dispatcher', 'DELETE price-book/items/:id', await D.del(`/api/price-book/items/${F.itemId}`));
  const ditem = await D.get(`/api/inventory/items/${F.itemId}`);
  ck(C2, 'no cost on the stock item', 'dispatcher', 'no cost key', costKeys(ditem.body).join(',') || 'none', costKeys(ditem.body).length === 0);
  const dpo = await D.get(`/api/inventory/purchase-orders/${F.poId}`);
  ck(C2, 'linked purchase order opens, without amounts', 'dispatcher', '200, no cost key', `${dpo.status} ${costKeys(dpo.body).join(',') || 'none'}`, dpo.status === 200 && costKeys(dpo.body).length === 0);
  allowed(C2, 'linked logistic order opens', 'dispatcher', 'GET logistic-orders/:id', await D.get(`/api/logistic-orders/${F.o1}`));
  const dven = await D.get(`/api/inventory/vendors/${F.vendorId}`);
  ck(C2, 'vendor contact without account number', 'dispatcher', '200, no accountNumber', `${dven.status} ${costKeys(dven.body).join(',') || 'none'}`, dven.status === 200 && costKeys(dven.body).length === 0);
  for (const [label, r] of [
    ['restock', await D.post('/api/inventory/restock', { itemId: F.itemId, locationId: F.warehouseId, qty: 1 })],
    ['transfer', await D.post('/api/inventory/transfer', { itemId: F.itemId, fromId: F.warehouseId, toId: F.vanId, qty: 1 })],
    ['count', await D.post('/api/inventory/stock/set-quantity', { itemId: F.itemId, locationId: F.warehouseId, newQty: 3 })],
    ['reserve levels', await D.put('/api/inventory/stock/thresholds', { itemId: F.itemId, locationId: F.warehouseId, min: 1, max: 5 })],
    ['new location', await D.post('/api/inventory/locations', { name: `${PREFIX} nope`, type: 'warehouse' })],
    ['new asset', await D.post('/api/inventory/assets', { name: `${PREFIX} nope` })],
    ['Create PO', await D.post('/api/inventory/purchase-orders', { vendorId: F.vendorId, lines: [{ itemName: 'x', uom: 'ea', qtyOrdered: 1 }] })],
    ['Create PO from the job page', await D.post('/api/inventory/purchase-orders/from-job', { jobId: F.job3.id })],
    ['purchase order edit', await D.patch(`/api/inventory/purchase-orders/${F.poId}`, { notes: 'x' })],
    ['purchase order mark ordered', await D.post(`/api/inventory/purchase-orders/${F.poId}/mark-ordered`, {})],
    ['purchase order receive', await D.post('/api/inventory/purchase-orders/receive', { purchaseOrderId: F.poId, lines: [] })],
    ['purchase order delete', await D.del(`/api/inventory/purchase-orders/${F.poId}`)],
    ['vendor create', await D.post('/api/inventory/vendors', { name: `${PREFIX} nope` })],
    ['vendor edit', await D.post('/api/inventory/vendors', { id: F.vendorId, name: `${PREFIX} nope` })],
    ['vendor delete', await D.del(`/api/inventory/vendors/${F.vendorId}`)],
    ['stage create', await D.post('/api/inventory/job-stages', { jobId: F.job1.id, jobNumber: F.job1.number, customer: `${PREFIX} nope`, site: 'x', trade: 'general', status: 'awaiting' })],
    ['stage edit', await D.patch(`/api/inventory/job-stages/${F.stages.s2}`, { notes: 'x' })],
    ['stage receive', await D.post('/api/inventory/job-stages/receive', { stageId: F.stages.s2, lineId: F.itemId, qty: 1 })],
    ['stage notify', await D.post('/api/inventory/job-stages/notify', { stageId: F.stages.s2 })],
  ]) refused(C2, label, 'dispatcher', 'write attempt', r);
  const dTake = await D.post(`/api/inventory/job-stages/${F.stages.s2}/taken-by-me`);
  ck(C2, 'Taken by me on a stage, without Edit stock', 'dispatcher', 'saved: taken by and recorded by the dispatcher', `${dTake.status} ${dTake.body?.jobStage?.takenByName ?? '-'}`, dTake.status === 200 && dTake.body?.jobStage?.takenById === D.id && dv.edit_stock === false);
  const dExports = ['Inventory', 'PriceBook', 'PurchaseOrder', 'Vendor', 'Report'].filter((s) => has(drules, 'export', s));
  ck(C2, 'no exports', 'dispatcher', 'no export rule', dExports.join(',') || 'none', dExports.length === 0);
  allowed(C2, 'Service Plans on', 'dispatcher', 'GET service-plans', await D.get('/api/service-plans'));
  ck(C2, 'Service Plans managed', 'dispatcher', 'create and update rules', `create ${has(drules, 'create', 'ServicePlan')}, update ${has(drules, 'update', 'ServicePlan')}`, has(drules, 'create', 'ServicePlan') && has(drules, 'update', 'ServicePlan'));
  refused(C2, 'Automations', 'dispatcher', 'GET workflows', await D.get('/api/workflows'));
  refused(C2, 'Billing', 'dispatcher', 'GET reports/ar-aging', await D.get('/api/reports/ar-aging'));
  refused(C2, 'Reports', 'dispatcher', 'GET reports/jobs', await D.get('/api/reports/jobs'));
  ck(C2, 'Marketing is off (display only)', 'dispatcher', 'access_marketing false', String(dv.access_marketing), dv.access_marketing === false);

  // ── C4: "Taken by..." recorded by the dispatcher for the technician ───────────────────────────────────────
  const C4 = 'C4 taken by (recorded)';
  const people = await D.get(`/api/inventory/job-stages/${F.stages.s4}/pickup-people`);
  ck(C4, 'the picker lists the technician', 'dispatcher', 'technician among the people', `${people.status} ${(people.body?.people ?? []).some((x) => x.id === T.id)}`, (people.body?.people ?? []).some((x) => x.id === T.id));
  const rec = await D.post(`/api/inventory/job-stages/${F.stages.s4}/taken-by`, { takenById: T.id });
  const s4 = rec.body?.jobStage;
  const expectedLine = `Taken by ${T.name}, recorded by ${D.name}`;
  ck(C4, 'stage: taken by the technician, recorded by the dispatcher', 'dispatcher', 'takenBy technician, recordedBy dispatcher', `${rec.status} ${s4?.takenByName ?? '-'} / ${s4?.recordedByName ?? '-'}`, rec.status === 200 && s4?.takenById === T.id && s4?.recordedById === D.id);
  const s4note = (s4?.auditLog ?? []).at(-1)?.comment;
  ck(C4, 'stage history reads the full line', 'dispatcher', expectedLine, s4note ?? '-', s4note === expectedLine);
  const ord = await D.post(`/api/logistic-orders/${F.o1}/taken-by`, { takenById: T.id });
  ck(C4, 'order: taken by the technician, recorded by the dispatcher', 'dispatcher', 'takenBy technician, recordedBy dispatcher', `${ord.status} ${ord.body?.takenBy?.name ?? '-'} / ${ord.body?.recordedBy?.name ?? '-'}`, ord.status === 200 && ord.body?.takenBy?.id === T.id && ord.body?.recordedBy?.id === D.id);
  const auditRows = psql(`select metadata->>'comment' from audit_logs where resource_id=${sq(F.o1)} and action='inventory.logistic_order_picked_up'`);
  ck(C4, 'order history reads the full line', 'dispatcher', expectedLine, auditRows[0]?.[0] ?? '-', auditRows[0]?.[0] === expectedLine);
  const tOrd = await T.get(`/api/logistic-orders/${F.o1}`);
  ck(C4, 'the technician reads the same on the order', 'technician', 'takenBy technician, recordedBy dispatcher', `${tOrd.body?.takenBy?.name ?? '-'} / ${tOrd.body?.recordedBy?.name ?? '-'}`, tOrd.body?.takenBy?.id === T.id && tOrd.body?.recordedBy?.id === D.id && !actionsOf(tOrd).includes('pick_up'));

  // ── C5: Sales ─────────────────────────────────────────────────────────────────────────────────────────────
  const C5 = 'C5 sales';
  const sm = inventoryMenu(sv);
  ck(C5, 'menu: Inventory with Stock, Price Book, Purchase Orders, Vendors', 'sales', 'heading with those four (orders tab lives on Stock)', `${sm.heading ? 'heading' : 'no heading'}: ${sm.children.join(', ')}`, sm.heading && sameList(sm.children, ['Stock', 'Price Book', 'Purchase Orders', 'Vendors']));
  ck(C5, 'Logistic Orders tab stays', 'sales', 'view and show on', `view ${sv.view_logistic_orders}, show ${sv.show_logistic_orders_page}`, sv.view_logistic_orders === true && sv.show_logistic_orders_page === true);
  const sitem = await S.get(`/api/inventory/items/${F.itemId}`);
  ck(C5, 'costs stay: stock item cost', 'sales', 'unitCost 12.34', String(sitem.body?.item?.unitCost), Number(sitem.body?.item?.unitCost) === 12.34);
  const spb = await S.get(`/api/price-book/items/${F.itemId}`);
  ck(C5, 'costs stay: price book cost', 'sales', 'unit_cost 12.34', String(spb.body?.data?.unit_cost), Number(spb.body?.data?.unit_cost) === 12.34);
  const spo = await S.get(`/api/inventory/purchase-orders/${F.poId}`);
  ck(C5, 'costs stay: purchase order line cost', 'sales', 'unitCost 12.34 on the line', String(spo.body?.purchaseOrder?.lines?.[0]?.unitCost), Number(spo.body?.purchaseOrder?.lines?.[0]?.unitCost) === 12.34);
  const sven = await S.get(`/api/inventory/vendors/${F.vendorId}`);
  ck(C5, 'vendor contacts stay (with account number)', 'sales', 'contact email and account number', `${sven.body?.vendor?.contactEmail ?? '-'} / ${sven.body?.vendor?.accountNumber ?? '-'}`, sven.body?.vendor?.contactEmail === 'delivered@resend.dev' && sven.body?.vendor?.accountNumber === 'ACCT-0724');
  const sExports = ['Inventory', 'PriceBook', 'PurchaseOrder', 'Vendor'].filter((s) => has(srules, 'export', s));
  ck(C5, 'inventory exports stay', 'sales', 'export on Inventory, PriceBook, PurchaseOrder, Vendor', sExports.join(',') || 'none', sameList(sExports, ['Inventory', 'PriceBook', 'PurchaseOrder', 'Vendor']));
  const o3 = await S.post('/api/logistic-orders', { job_id: F.job3.id, lines: [lineOf()], notes: PREFIX });
  allowed(C5, 'sales creates an order on a job from their own lead', 'sales', 'POST logistic-orders', o3);
  F.o3 = o3.body?.id;
  const o3s = await S.post(`/api/logistic-orders/${F.o3}/submit`);
  ck(C5, 'sales submits it', 'sales', 'PENDING_APPROVAL', `${o3s.status} ${statusOf(o3s)}`, statusOf(o3s) === 'PENDING_APPROVAL');
  refused(C5, 'sales cannot approve', 'sales', 'POST approve', await S.post(`/api/logistic-orders/${F.o3}/approve`));
  const o3w = await S.get(`/api/logistic-orders/${F.o3}`);
  ck(C5, 'it waits for an approver', 'sales', 'still PENDING_APPROVAL, no approve/process action', `${statusOf(o3w)} [${actionsOf(o3w).join(',')}]`, statusOf(o3w) === 'PENDING_APPROVAL' && !actionsOf(o3w).includes('approve') && !actionsOf(o3w).includes('process'));
  // An approver (the admin) approves and processes it, so the sales person can be shown a Processed order.
  await admin.post(`/api/logistic-orders/${F.o3}/approve`);
  await admin.post(`/api/logistic-orders/${F.o3}/process`);
  const o3p = await S.get(`/api/logistic-orders/${F.o3}`);
  ck(C5, 'no pickup buttons on a Processed order', 'sales', 'status PROCESSED, no pick_up or record_pickup', `${statusOf(o3p)} [${actionsOf(o3p).join(',')}]`, statusOf(o3p) === 'PROCESSED' && !actionsOf(o3p).includes('pick_up') && !actionsOf(o3p).includes('record_pickup'));
  hidden(C5, 'an order on a job not from their leads, by link', 'sales', 'GET logistic-orders/:id', await S.get(`/api/logistic-orders/${F.o1}`));
  const sList = await S.get('/api/logistic-orders?limit=100');
  const sIds = (sList.body?.data ?? []).map((o) => o.id);
  ck(C5, 'reach: orders on jobs from their own leads only', 'sales', 'o3 listed; o1 and o2 not', `o3 ${sIds.includes(F.o3)}, o1 ${sIds.includes(F.o1)}, o2 ${sIds.includes(F.o2)}`, sIds.includes(F.o3) && !sIds.includes(F.o1) && !sIds.includes(F.o2));
  refused(C5, 'Taken by me on a stage', 'sales', 'POST taken-by-me', await S.post(`/api/inventory/job-stages/${F.stages.s2}/taken-by-me`));
  refused(C5, 'Taken by... on a stage', 'sales', 'POST taken-by', await S.post(`/api/inventory/job-stages/${F.stages.s2}/taken-by`, { takenById: T.id }));
  refused(C5, 'Taken by me on an order', 'sales', 'POST taken-by-me', await S.post(`/api/logistic-orders/${F.o3}/taken-by-me`));
  refused(C5, 'Taken by... on an order', 'sales', 'POST taken-by', await S.post(`/api/logistic-orders/${F.o3}/taken-by`, { takenById: T.id }));

  // ── C6: the Inventory heading follows its children ────────────────────────────────────────────────────────
  const C6 = 'C6 inventory heading';
  for (const [k, who] of [['tech', 'technician'], ['disp', 'dispatcher'], ['sales', 'sales'], ['approver', 'approver'], ['solo', 'solo']]) {
    const m = inventoryMenu(mine[k].values);
    ck(C6, 'heading shows exactly when a child shows', who, 'heading iff at least one child', `heading ${m.heading}, children ${m.children.join(', ') || 'none'}`, m.heading === (m.children.length > 0));
  }
  ck(C6, 'a person with a single child on still has the heading', 'dispatcher', 'one child (Price Book) and the heading', `${dm.children.length} child, heading ${dm.heading}`, dm.children.length === 1 && dm.heading);

  // ── C7: the presets are what the migration wrote; the old grants are gone in effect ───────────────────────
  const C7 = 'C7 migration shape (staging)';
  for (const [key, role, who] of [['tech', 'TECHNICIAN', 'technician'], ['disp', 'DISPATCHER', 'dispatcher'], ['sales', 'SALES', 'sales']]) {
    const diffs = catalog.filter((s) => JSON.stringify(mine[key].values[s.key]) !== JSON.stringify(s.presets[role])).map((s) => s.key);
    ck(C7, 'every switch holds the preset value', who, `0 switches differ from the ${role} preset`, diffs.length ? `${diffs.length}: ${diffs.slice(0, 6).join(', ')}` : '0 differ', diffs.length === 0);
  }
  ck(C7, 'the hand-made technician grants have no effect', 'technician', 'PO read/create, vendor read, order create/update all refused (see C1)', rows.filter((r) => r.criterion === C1 && /Purchase Orders list|purchase order create|Vendors list|order create|order edit/.test(r.id)).map((r) => (r.ok ? 'refused' : 'ALLOWED')).join(','), rows.filter((r) => r.criterion === C1 && /Purchase Orders list|purchase order create|Vendors list|order create|order edit/.test(r.id)).every((r) => r.ok));
  const hand = psql(`select action || ' ' || subject, count(*) from role_permissions where organization_id=${sq(ORG)} and role='TECHNICIAN' and subject in ('PurchaseOrder','Vendor','LogisticOrder') group by 1 order by 1`);
  ck(C7, 'old rows of that shape in the demo organization (information)', 'staging', 'the migration reads them and never deletes them', hand.length ? hand.map((h) => `${h[0]} x${h[1]}`).join('; ') : 'none present', true);
}

// ─── Browser pass ─────────────────────────────────────────────────────────────
// Headless Chromium from this checkout's node_modules (never a person's own browser). Each fixture person's session goes
// into the page's storage before the app loads; nothing is typed or printed. Screenshots land in .qa/ (gitignored).

// Vendor names are listed here; real company names are read from the database at run time (every organization that is not
// a demo one), so no real name is written in this file and none is ever printed.
const VENDOR_NAME = /supabase|calltracking|\bctm\b|onrender|render\.com|stripe|twilio|resend|vercel/i;

async function browserPass(admin) {
  const C9 = 'C9 browser pass';
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    ck(C9, 'playwright is installed', 'script', 'importable', 'not found (run npm ci at the repo root)', false);
    return;
  }
  const P = F.people;
  const num = async (id) => (await admin.get(`/api/logistic-orders/${id}`)).body?.number;
  const o1n = await num(F.o1);
  const o2n = await num(F.o2);
  const poNo = (await admin.get(`/api/inventory/purchase-orders/${F.poId}`)).body?.purchaseOrder?.poNumber;
  const realNames = psql(`select name from organizations where is_demo = false`).map((r) => r[0]).filter((n) => n && n.length >= 4);
  const escape = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const realNameRe = realNames.length ? new RegExp(realNames.map(escape).join('|'), 'i') : null;
  const clean = (r) => {
    const text = r.text.replace(/\S*@resend\.dev/g, '');
    return !VENDOR_NAME.test(text) && !(realNameRe && realNameRe.test(text));
  };
  const browser = await chromium.launch({ headless: true });
  const shots = [];
  let rateLimited = 0;

  async function visit(person, viewport, label, path, { click, settle = 2500 } = {}) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } }, [STORAGE_KEY, JSON.stringify(person.session)]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`page error: ${String(e).slice(0, 120)}`));
    await page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(settle);
    if (click) {
      await page.getByText(click, { exact: true }).first().click({ timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const text = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
    const nav = await page.locator('nav a, aside a').evaluateAll((as) => as.map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href') })));
    const tabs = await page.locator('[role="tab"]').allInnerTexts().catch(() => []);
    const buttons = (await page.locator('button, a[role="button"]').allInnerTexts().catch(() => [])).map((b) => b.trim());
    const headers = (await page.locator('th, [role="columnheader"]').allInnerTexts().catch(() => [])).map((h) => h.trim());
    const url = new URL(page.url());
    const file = `${REPO}/.qa/rp-s0724-${RUN}-${person.key}-${label}-${viewport.width}.png`;
    await page.screenshot({ path: file }).catch(() => {});
    shots.push(file);
    const noise = errors.filter((e) => /status of 429/.test(e));
    rateLimited += noise.length;
    await ctx.close();
    await sleep(1500);
    return { text, nav, tabs, buttons, headers, path: url.pathname, errors: errors.filter((e) => !/status of 429/.test(e)) };
  }
  const links = (r) => r.nav.map((n) => n.href);

  const desktop = { width: 1440, height: 900 };
  const phone = { width: 390, height: 844 };

  try {
    // ── technician ──
    const T = P.tech;
    const tl = await visit(T, desktop, 'stock', '/inventory');
    ck(C9, 'menu: Inventory heading with Stock; Price Book reachable', 'technician', 'Inventory group, Stock and Price Book links', `inventory group ${/Inventory/.test(tl.text)}, stock ${links(tl).includes('/inventory')}, price book ${links(tl).includes('/inventory/price-book')}`, /Inventory/.test(tl.text) && links(tl).includes('/inventory') && links(tl).includes('/inventory/price-book'));
    const shut = ['/inventory/purchase-orders', '/inventory/vendors', '/inventory/logistic-orders', '/service-plans', '/automations', '/reports', '/reports/unpaid-invoices', '/marketing'].filter((h) => links(tl).includes(h));
    ck(C9, 'menu: no Purchase Orders, Vendors, Logistic Orders, Service Plans, Automations, Reports, Billing, Marketing', 'technician', 'none of those links', shut.join(',') || 'none', shut.length === 0);
    ck(C9, 'Inventory tabs: no Activity, no Logistic Orders', 'technician', 'tabs without Activity or Logistic Orders', tl.tabs.map((t) => t.replace(/\s+\d+.*$/, '')).join(', '), tl.tabs.length > 0 && !tl.tabs.some((t) => /^(Activity|Logistic Orders)/.test(t)));
    const stockCosts = tl.headers.filter((h) => /cost|value|margin/i.test(h));
    ck(C9, 'no cost column or Inventory Value card on the Stock page', 'technician', 'no cost or value column; no Inventory Value card', `columns ${stockCosts.join(',') || 'none'} (of ${tl.headers.length}); card ${/Inventory Value/i.test(tl.text)}`, tl.headers.length > 0 && stockCosts.length === 0 && !/Inventory Value/i.test(tl.text));
    const stockWrites = tl.buttons.filter((b) => /^(Add|New|Restock|Transfer|Count|Import|Receive)/i.test(b));
    ck(C9, 'Stock page: no add, restock, transfer or count controls', 'technician', 'none', stockWrites.join(',') || 'none', stockWrites.length === 0);
    const tlo = await visit(T, desktop, 'orders-list', '/inventory/logistic-orders');
    ck(C9, 'the Logistic Orders list address goes home', 'technician', 'redirected to /', tlo.path, tlo.path === '/');
    const tpo = await visit(T, desktop, 'po', `/inventory/purchase-orders/${F.poId}`);
    ck(C9, 'a purchase order link answers not found', 'technician', 'Purchase order not found', /not found/i.test(tpo.text) ? 'not found shown' : tpo.text.slice(0, 60), /Purchase order not found/i.test(tpo.text));
    const tjob = await visit(T, desktop, 'job', `/jobs/${F.job1.id}`, { click: 'Logistics' });
    ck(C9, "job page Logistics: the job's orders", 'technician', `${o1n} and ${o2n} listed`, `${o1n} ${tjob.text.includes(o1n)}, ${o2n} ${tjob.text.includes(o2n)}`, tjob.text.includes(o1n) && tjob.text.includes(o2n));
    ck(C9, 'job page: no Create PO, no material cost', 'technician', 'neither shows', `create PO ${/Create PO/i.test(tjob.text)}, material cost ${/Material cost/i.test(tjob.text)}`, !/Create PO/i.test(tjob.text) && !/Material cost/i.test(tjob.text));
    const tlo1 = await visit(T, desktop, 'order', `/inventory/logistic-orders/${F.o1}`);
    const takenLine = `Taken by ${T.name}, recorded by ${P.disp.name}`;
    ck(C9, 'order record reads "Taken by <technician>, recorded by <dispatcher>"', 'technician', takenLine, tlo1.text.includes(takenLine) ? takenLine : 'line not found', tlo1.text.includes(takenLine));
    for (const [label, r] of [['stock', tl], ['orders-list', tlo], ['po', tpo], ['job', tjob], ['order', tlo1]]) {
      ck(C9, `console and names on the ${label} page (desktop)`, 'technician', 'no console error, no vendor or real customer name', `${r.errors.length} errors${r.errors[0] ? `: ${r.errors[0].slice(0, 70)}` : ''}; names ${clean(r) ? 'clean' : 'FOUND'}`, r.errors.length === 0 && clean(r));
    }
    for (const [label, path, click] of [['stock', '/inventory'], ['job', `/jobs/${F.job1.id}`, 'Logistics'], ['order', `/inventory/logistic-orders/${F.o1}`]]) {
      const r = await visit(T, phone, label, path, { click });
      ck(C9, `${label} page at 390 px`, 'technician', 'no console error, no vendor or real customer name', `${r.errors.length} errors; names ${clean(r) ? 'clean' : 'FOUND'}`, r.errors.length === 0 && clean(r));
    }

    // ── dispatcher ──
    const D = P.disp;
    const dp = await visit(D, desktop, 'price-book', '/inventory/price-book');
    ck(C9, 'menu: Price Book (own entry and the single Inventory child)', 'dispatcher', 'Inventory group; Price Book link; no Stock link', `group ${/Inventory/.test(dp.text)}, price book ${links(dp).includes('/inventory/price-book')}, stock ${links(dp).includes('/inventory')}`, /Inventory/.test(dp.text) && links(dp).includes('/inventory/price-book') && !links(dp).includes('/inventory'));
    const dshut = ['/inventory', '/inventory/purchase-orders', '/inventory/vendors', '/inventory/logistic-orders', '/automations', '/reports', '/reports/unpaid-invoices', '/marketing'].filter((h) => links(dp).includes(h));
    ck(C9, 'menu: no Stock, Purchase Orders, Vendors, Logistic Orders, Automations, Billing, Reports, Marketing', 'dispatcher', 'none of those links', dshut.join(',') || 'none', dshut.length === 0);
    ck(C9, 'menu: Service Plans on', 'dispatcher', 'Service Plans link', String(links(dp).includes('/service-plans')), links(dp).includes('/service-plans'));
    const pbWrites = dp.buttons.filter((b) => /^(Add Item|Add Brand|New Bundle|Add category|Import)/i.test(b));
    const pbCosts = dp.headers.filter((h) => /cost|margin|markup|profit/i.test(h));
    ck(C9, 'Price Book: view only and no cost or margin column', 'dispatcher', 'no Add/Import/New buttons; no cost, margin column', `buttons ${pbWrites.join(',') || 'none'}; columns ${pbCosts.join(',') || 'none'} (of ${dp.headers.length})`, dp.headers.length > 0 && pbWrites.length === 0 && pbCosts.length === 0);
    const hiddenLists = [];
    for (const path of ['/inventory', '/inventory/purchase-orders', '/inventory/vendors', '/inventory/logistic-orders']) {
      const r = await visit(D, desktop, `list${path.replace(/\W+/g, '-')}`, path, { settle: 1500 });
      hiddenLists.push(`${path} -> ${r.path}`);
    }
    ck(C9, 'Stock, Purchase Orders, Vendors, Logistic Orders lists go home', 'dispatcher', 'each redirects to /', hiddenLists.join('; '), hiddenLists.every((x) => x.endsWith('-> /')));
    const dpo = await visit(D, desktop, 'po', `/inventory/purchase-orders/${F.poId}`);
    ck(C9, 'linked purchase order record opens, no Edit or Receive', 'dispatcher', `${poNo} shown; no Edit, Receive, Delete`, `${dpo.text.includes(String(poNo))}; ${/\b(Edit|Receive items|Delete)\b/.test(dpo.text) ? 'a write control shows' : 'no write control'}`, dpo.text.includes(String(poNo)) && !/\b(Edit|Receive items|Delete)\b/.test(dpo.text));
    const dlo = await visit(D, desktop, 'order', `/inventory/logistic-orders/${F.o1}`);
    ck(C9, 'linked logistic order record opens', 'dispatcher', `${o1n} shown`, String(dlo.text.includes(o1n)), dlo.text.includes(o1n));
    const djob = await visit(D, desktop, 'job', `/jobs/${F.job1.id}`, { click: 'Logistics' });
    ck(C9, "job page Logistics: the job's orders, no Create PO", 'dispatcher', `${o1n} listed; no Create PO`, `${djob.text.includes(o1n)}; ${/Create PO/i.test(djob.text) ? 'Create PO shows' : 'no Create PO'}`, djob.text.includes(o1n) && !/Create PO/i.test(djob.text));
    for (const [label, r] of [['price-book', dp], ['po', dpo], ['order', dlo], ['job', djob]]) {
      ck(C9, `console and names on the ${label} page (desktop)`, 'dispatcher', 'no console error, no vendor or real customer name', `${r.errors.length} errors${r.errors[0] ? `: ${r.errors[0].slice(0, 70)}` : ''}; names ${clean(r) ? 'clean' : 'FOUND'}`, r.errors.length === 0 && clean(r));
    }
    for (const [label, path, click] of [['price-book', '/inventory/price-book'], ['job', `/jobs/${F.job1.id}`, 'Logistics'], ['order', `/inventory/logistic-orders/${F.o1}`], ['po', `/inventory/purchase-orders/${F.poId}`]]) {
      const r = await visit(D, phone, label, path, { click });
      ck(C9, `${label} page at 390 px`, 'dispatcher', 'no console error, no vendor or real customer name', `${r.errors.length} errors; names ${clean(r) ? 'clean' : 'FOUND'}`, r.errors.length === 0 && clean(r));
    }
  } finally {
    await browser.close();
  }
  ck(C9, 'names checked against (information)', 'staging', 'vendor names and every non-demo organization name', `${realNames.length} company names, not printed`, true);
  ck(C9, 'rate-limited answers during the pass (information)', 'staging', 'counted, not a failure', String(rateLimited), true);
  console.log(`  screenshots (gitignored): ${shots.length} files named .qa/rp-s0724-${RUN}-*.png`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function printTable() {
  const w = { check: 34, who: 11, expected: 58, got: 58 };
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}~` : s.padEnd(n));
  console.log(`\n  ${cut('check', w.check)} ${cut('who', w.who)} ${cut('expected', w.expected)} ${cut('got', w.got)} result`);
  let current = null;
  for (const r of rows) {
    if (r.criterion !== current) {
      current = r.criterion;
      console.log(`\n  == ${current}`);
    }
    console.log(`  ${cut(r.id, w.check)} ${cut(r.who, w.who)} ${cut(r.expected, w.expected)} ${cut(r.got, w.got)} ${r.ok ? 'PASS' : 'FAIL'}`);
  }
  const bad = rows.filter((r) => !r.ok);
  console.log(`\n  ${rows.length} checks, ${rows.length - bad.length} passed, ${bad.length} failed\n`);
  for (const r of bad) console.log(`  FAIL [${r.criterion}] ${r.id} (${r.who}): expected ${r.expected}; got ${r.got}`);
}

async function main() {
  const admin = new Person('admin', ADMIN_EMAIL);
  admin.session = await mint(ADMIN_EMAIL);
  const me = await admin.get('/api/auth/me');
  const who = me.body?.user ?? me.body;
  if (me.status !== 200 || who?.org_is_demo !== true || who?.organization_id !== ORG) die('refusing: the admin session does not resolve to the staging demo organization');

  if (flagValue('cleanup')) {
    console.log(`\n  cleaning up run ${RUN} (prefix "${PREFIX}")`);
    const notRemoved = await cleanup(admin);
    const still = leftovers();
    console.log(`  not removed: ${notRemoved.length ? notRemoved.join('; ') : 'nothing'}`);
    console.log(`  rows with the prefix still in the database: ${still.length ? still.map(([l, n]) => `${l} ${n}`).join(', ') : 'none'}`);
    console.log(`  sessions signed out: ${await signOutMinted()}\n`);
    process.exit(still.length || notRemoved.length ? 1 : 0);
  }

  console.log(`\n  run ${RUN}, prefix "${PREFIX}", staging demo organization`);
  let crashed = null;
  try {
    await provision(admin);
    await walk(admin);
  } catch (err) {
    crashed = err;
    console.error(`\n  the walk stopped: ${err.message}`);
  } finally {
    let people = 0;
    if (!flag('keep')) {
      people = await signOutMinted((email) => email !== ADMIN_EMAIL);
      const notRemoved = await cleanup(admin);
      const still = leftovers();
      ck('C8 fixtures removed', 'nothing left behind', 'script', 'no row with the run prefix is left', still.length ? still.map(([l, n]) => `${l} ${n}`).join(', ') : 'none', still.length === 0);
      if (notRemoved.length) console.log(`  cleanup notes: ${notRemoved.join('; ')}`);
    } else {
      console.log(`  --keep: fixtures left in place; remove them with: node scripts/qa-rp-presets-walk.mjs --cleanup ${RUN}`);
    }
    const out = await signOutMinted();
    console.log(`  sessions signed out: ${people + out}`);
  }
  printTable();
  process.exit(crashed || rows.some((r) => !r.ok) ? 1 : 0);
}

await main();
