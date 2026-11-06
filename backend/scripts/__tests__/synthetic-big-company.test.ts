/* =============================================================================
   The synthetic big company (#2984): the parts that need no database.

   - The sizes come from arguments or environment variables, defaulting to 15,000 customers,
     5,000 overdue leads and 60 staff.
   - The target check refuses any database that is not this machine's or one the person running it
     names as staging at run time (host AND project ref, both from the environment, never the repo).
   - The generated company is obviously fake: generated names, emails on a reserved test domain,
     phone numbers in the 555-01XX range kept for fiction, and every lead already past its Spider
     limit by the sweep's own stage rule.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  DEFAULT_SIZES,
  SYNTHETIC_EMAIL_DOMAIN,
  SYNTHETIC_SPIDER_LIMITS,
  FAST_DELETE_STATEMENTS,
  buildSyntheticCompany,
  checkDatabaseTarget,
  parseSyntheticCompanyArgs,
} from '../synthetic-big-company';
import { limitMs, readStatusLimits, spiderStageOf } from '../../src/services/spider/config';

describe('parseSyntheticCompanyArgs', () => {
  it('defaults to 15,000 customers, 5,000 overdue leads and 60 staff', () => {
    expect(DEFAULT_SIZES).toEqual({ customers: 15_000, overdueLeads: 5_000, staff: 60 });
    expect(parseSyntheticCompanyArgs(['seed'], {})).toEqual({
      ok: true, command: 'seed', sizes: { customers: 15_000, overdueLeads: 5_000, staff: 60 }, chunkSize: 1_000,
    });
  });

  it('reads the sizes from environment variables, and an argument wins over its variable', () => {
    const env = { SYNTHETIC_COMPANY_CUSTOMERS: '300', SYNTHETIC_COMPANY_OVERDUE_LEADS: '120', SYNTHETIC_COMPANY_STAFF: '9' };
    expect(parseSyntheticCompanyArgs(['seed'], env)).toMatchObject({ ok: true, sizes: { customers: 300, overdueLeads: 120, staff: 9 } });
    expect(parseSyntheticCompanyArgs(['seed', '--customers', '40', '--staff', '5', '--chunk-size', '250'], env)).toMatchObject({
      ok: true, sizes: { customers: 40, overdueLeads: 120, staff: 5 }, chunkSize: 250,
    });
  });

  it('knows exactly the seed, delete and status commands', () => {
    expect(parseSyntheticCompanyArgs(['delete'], {})).toMatchObject({ ok: true, command: 'delete' });
    expect(parseSyntheticCompanyArgs(['status'], {})).toMatchObject({ ok: true, command: 'status' });
    expect(parseSyntheticCompanyArgs([], {}).ok).toBe(false);
    expect(parseSyntheticCompanyArgs(['wipe'], {}).ok).toBe(false);
    expect(parseSyntheticCompanyArgs(['seed', '--org', 'x'], {}).ok).toBe(false);
  });

  it('refuses a size that is not a whole number in range', () => {
    for (const bad of [['--customers', '0'], ['--customers', 'x'], ['--customers', '1.5'], ['--staff', '0'], ['--overdue-leads', '-1'], ['--customers', '60001'], ['--staff', '501']]) {
      expect(parseSyntheticCompanyArgs(['seed', ...bad], {}).ok).toBe(false);
    }
    expect(parseSyntheticCompanyArgs(['seed'], { SYNTHETIC_COMPANY_STAFF: 'many' }).ok).toBe(false);
  });
});

describe('checkDatabaseTarget (never production)', () => {
  const local = 'postgresql://postgres@127.0.0.1:5433/rr_se2984';
  const remote = 'postgresql://postgres.abcdefstagingref:secret@pooler.example.net:6543/postgres';

  it('accepts a database on this machine', () => {
    for (const url of [local, 'postgresql://u@localhost:5432/dev', 'postgresql://u@[::1]:5432/dev']) {
      expect(checkDatabaseTarget({ databaseUrl: url })).toMatchObject({ ok: true });
    }
  });

  it('names the target without its credentials', () => {
    const r = checkDatabaseTarget({ databaseUrl: remote, allowedHosts: 'pooler.example.net', allowedRef: 'abcdefstagingref' });
    expect(r).toEqual({ ok: true, target: 'pooler.example.net:6543/postgres' });
  });

  it('refuses a remote database unless its host AND its project ref are named at run time', () => {
    const cases: Array<Record<string, string | undefined>> = [
      {},
      { allowedHosts: 'pooler.example.net' },
      { allowedRef: 'abcdefstagingref' },
      { allowedHosts: 'other.example.net', allowedRef: 'abcdefstagingref' },
      { allowedHosts: 'pooler.example.net', allowedRef: 'someotherref' },
      { allowedHosts: 'pooler.example.net', allowedRef: '   ' },
    ];
    for (const c of cases) {
      const r = checkDatabaseTarget({ databaseUrl: remote, ...c });
      expect(r.ok, JSON.stringify(c)).toBe(false);
    }
  });

  it('matches the ref only in the user name or the host, never in the password or the path', () => {
    const inPassword = 'postgresql://postgres.prodref:abcdefstagingref@pooler.example.net:6543/postgres';
    const inPath = 'postgresql://postgres.prodref:x@pooler.example.net:6543/abcdefstagingref';
    for (const url of [inPassword, inPath]) {
      expect(checkDatabaseTarget({ databaseUrl: url, allowedHosts: 'pooler.example.net', allowedRef: 'abcdefstagingref' }).ok).toBe(false);
    }
    expect(checkDatabaseTarget({ databaseUrl: 'postgresql://u:p@db.abcdefstagingref.example.net:5432/postgres', allowedHosts: 'db.abcdefstagingref.example.net', allowedRef: 'abcdefstagingref' }).ok).toBe(true);
  });

  // Round 2 (verifier, Medium): Prisma takes the connection host from `?host=` OVER the URL's own host, so
  // `localhost?host=<anywhere>` once passed as "this machine" and then connected anywhere. The target judged must
  // be the one the driver connects to: every form that can move the connection, or name more than one host, is
  // refused, on this machine and on an allowlisted host alike.
  const remoteAllow = { allowedHosts: 'pooler.example.net', allowedRef: 'abcdefstagingref' };
  it.each([
    ['?host= to another server', 'postgresql://u@localhost:5433/db?host=db-not-allowlisted.invalid'],
    ['?host= to an address', 'postgresql://u@127.0.0.1:5433/db?host=10.255.255.1'],
    ['?host= to a socket directory', 'postgresql://u@localhost/db?host=/var/run/postgresql'],
    ['?host= after a safe parameter', 'postgresql://u@localhost/db?schema=public&host=pooler.example.net'],
    ['?host= on an allowlisted host', 'postgresql://postgres.abcdefstagingref@pooler.example.net:6543/postgres?host=prod.example.net'],
    ['?HOST= (another spelling)', 'postgresql://u@localhost/db?HOST=elsewhere.example.net'],
    ['?hostaddr= (libpq)', 'postgresql://u@localhost/db?hostaddr=10.255.255.1'],
    ['?service= (libpq service file)', 'postgresql://u@localhost/db?service=prod'],
    ['an unknown parameter', 'postgresql://u@localhost/db?target_session_attrs=any'],
    ['a host list', 'postgresql://u@localhost,db.example.net:5432/db'],
    ['a host list on an allowlisted host', 'postgresql://postgres.abcdefstagingref@pooler.example.net,prod.example.net:6543/postgres'],
    ['no host (socket)', 'postgresql://u@/db?host=/tmp'],
    ['an encoded host', 'postgresql://u@%6Cocalhost/db'],
    ['an encoded slash in the host', 'postgresql://u@localhost%2Fevil/db'],
    ['a loopback-looking name', 'postgresql://u@127.0.0.1.nip.io/db'],
    ['another loopback spelling', 'postgresql://u@0x7f000001/db'],
    ['a pooled-proxy scheme', 'prisma+postgres://localhost/?api_key=x'],
    ['another database scheme', 'mysql://u@localhost/db'],
  ])('refuses %s', (_label, databaseUrl) => {
    expect(checkDatabaseTarget({ databaseUrl, ...remoteAllow }).ok).toBe(false);
  });

  it('still accepts the connection options that never choose the target', () => {
    expect(checkDatabaseTarget({ databaseUrl: 'postgresql://u@localhost:5432/dev?schema=public&connection_limit=1' })).toMatchObject({ ok: true });
    expect(checkDatabaseTarget({
      databaseUrl: 'postgresql://postgres.abcdefstagingref:x@pooler.example.net:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require',
      ...remoteAllow,
    })).toEqual({ ok: true, target: 'pooler.example.net:6543/postgres' });
    expect(checkDatabaseTarget({ databaseUrl: 'postgres://u@LOCALHOST:5432/dev' }).ok).toBe(true);
  });

  it('refuses inside a deployed server, and refuses a missing or broken URL', () => {
    expect(checkDatabaseTarget({ databaseUrl: local, nodeEnv: 'production' }).ok).toBe(false);
    expect(checkDatabaseTarget({ databaseUrl: undefined }).ok).toBe(false);
    expect(checkDatabaseTarget({ databaseUrl: 'not a url' }).ok).toBe(false);
  });
});

describe('every command refuses a database nobody named (the CLI itself)', () => {
  // The entry points: the three commands. Each runs the real script in a child process against a remote
  // database that is not allowlisted; each must refuse (exit 3) before it opens any connection.
  const script = join(__dirname, '..', 'synthetic-big-company.ts');
  const unnamedRemote = 'postgresql://postgres.someref@db.not-allowlisted.example.net:5432/postgres';
  // Round 2: "this machine" in the URL, but Prisma would connect to the host in the parameter.
  const hostParameter = 'postgresql://postgres@127.0.0.1:5433/postgres?host=db-not-allowlisted.invalid';
  it.each([
    ['seed', unnamedRemote], ['status', unnamedRemote], ['delete', unnamedRemote],
    ['seed', hostParameter], ['status', hostParameter], ['delete', hostParameter],
  ])('%s refuses %s', (command, databaseUrl) => {
    const run = spawnSync('npx', ['tsx', script, command], {
      cwd: join(__dirname, '..', '..'),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME,
        DATABASE_URL: databaseUrl,
        SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'placeholder',
        E2E_ALLOWED_DB_HOSTS: 'staging-only.example.net', E2E_ALLOWED_DB_REF: 'stagingref',
      },
    });
    expect(run.status, run.stderr).toBe(3);
    expect(run.stderr).toContain('Refusing to run');
    expect(run.stdout).not.toContain(`${command} on`);
  }, 60_000);
});

describe('buildSyntheticCompany', () => {
  const now = new Date('2026-11-03T15:00:00.000Z');
  const sizes = { customers: 1_000, overdueLeads: 700, staff: 60 };
  const company = buildSyntheticCompany(sizes, now);

  it('makes exactly the asked-for rows', () => {
    expect(company.customers).toHaveLength(1_000);
    expect(company.customerEmails).toHaveLength(1_000);
    expect(company.customerPhones).toHaveLength(1_000);
    expect(company.serviceLocations).toHaveLength(1_000);
    expect(company.leads).toHaveLength(700);
    expect(company.leadAssignees).toHaveLength(700);
    expect(company.staff).toHaveLength(60);
  });

  it('gives every lead a stage entry far enough back that it is past its Spider limit now', () => {
    const limits = readStatusLimits(SYNTHETIC_SPIDER_LIMITS as never);
    expect(limits.NEW.enabled && limits.CONTACTED.enabled).toBe(true);
    const stages = new Set<string>();
    for (const lead of company.leads) {
      const visit = spiderStageOf({
        status: lead.status, created_at: lead.created_at, contacted_at: lead.contacted_at, returned_to_new_at: null,
        walkthrough_first_booked_at: null, last_visit_completed_at: null, first_estimate_sent_at: null,
        won_at: null, lost_at: null, cancelled_at: null,
      });
      expect(visit, lead.lead_number).not.toBeNull();
      const limit = limits[visit!.stage];
      expect(limit.enabled).toBe(true);
      expect(now.getTime() - visit!.enteredAt.getTime()).toBeGreaterThan(limitMs(limit.value, limit.unit));
      stages.add(visit!.stage);
    }
    // Both watched stages are covered, and the leads are not all overdue by the same amount.
    expect([...stages].sort()).toEqual(['CONTACTED', 'NEW']);
    expect(new Set(company.leads.map((l) => (l.contacted_at ?? l.created_at).getTime())).size).toBeGreaterThan(600);
  });

  it('is obviously fake: reserved email domain, fictional 555-01XX phones, generated names, unique', () => {
    const emails = [...company.customers.map((c) => c.email), ...company.staff.map((s) => s.email), ...company.customerEmails.map((e) => e.email)];
    for (const e of emails) expect(e.endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`), e).toBe(true);
    expect(SYNTHETIC_EMAIL_DOMAIN.endsWith('.invalid')).toBe(true);
    const phones = [...company.customers.map((c) => c.phone), ...company.staff.map((s) => s.phone)];
    for (const p of phones) expect(p, p).toMatch(/^\+1[2-9]\d{2}55501\d{2}$/);
    expect(new Set(phones).size).toBe(phones.length);
    expect(new Set(company.staff.map((s) => s.email)).size).toBe(60);
    expect(new Set(company.customers.map((c) => c.customer_number)).size).toBe(1_000);
    expect(new Set(company.leads.map((l) => l.lead_number)).size).toBe(700);
    for (const c of company.customers) expect(`${c.last_name}`).toMatch(/^Sample \d{5}$/);
    for (const s of company.staff) expect(s.last_name).toMatch(/^Staff \d{2,3}$/);
  });

  it('staff can receive alerts: active, marked able to sign in, a mix of roles, no password anywhere', () => {
    const roles = company.staff.map((s) => s.role);
    expect(roles.filter((r) => r === 'ADMIN').length).toBeGreaterThanOrEqual(1);
    expect(new Set(roles)).toEqual(new Set(['ADMIN', 'DISPATCHER', 'SALES']));
    for (const s of company.staff) {
      expect(s).toMatchObject({ is_active: true, has_login: true, is_admin: s.role === 'ADMIN' });
      expect(Object.keys(s).some((k) => /pass/i.test(k))).toBe(false);
    }
    // Every lead has an owner on its own assignee row, so the owner can open it.
    const owners = new Set(company.staff.filter((s) => s.role === 'SALES').map((s) => s.id));
    for (const [i, lead] of company.leads.entries()) {
      expect(owners.has(lead.commission_owner_id!)).toBe(true);
      expect(company.leadAssignees[i]).toMatchObject({ lead_id: lead.id, user_id: lead.commission_owner_id });
    }
  });

  it('keeps every lead on one of the company customers and its service location', () => {
    const customerIds = new Set(company.customers.map((c) => c.id));
    const locationOf = new Map(company.serviceLocations.map((l) => [l.customer_id, l.id]));
    for (const lead of company.leads) {
      expect(customerIds.has(lead.customer_id)).toBe(true);
      expect(lead.service_location_id).toBe(locationOf.get(lead.customer_id));
    }
  });
});

describe('the delete statements', () => {
  // A source-driven guard: every statement the fast delete runs is scoped to the one company id it
  // is handed as $1, so no statement can reach another company's rows.
  it('every statement is a DELETE scoped by organization_id = $1, and nothing else is interpolated', () => {
    expect(FAST_DELETE_STATEMENTS.length).toBeGreaterThan(0);
    for (const sql of FAST_DELETE_STATEMENTS) {
      expect(sql).toMatch(/^DELETE FROM [a-z_]+ WHERE /);
      expect(sql).toContain('organization_id = $1::uuid');
      expect(sql.match(/\$\d/g)).toEqual(expect.arrayContaining(['$1']));
      expect(sql.match(/\$\d/g)!.every((p) => p === '$1')).toBe(true);
      expect(sql).not.toMatch(/\$\{/);
    }
  });
});
