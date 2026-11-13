/* =============================================================================
   Test helper (not a test file): what the #3108 suites share - the real app and the real jobs client wired to the test
   database, a Spider sweep in its own process that a test can stop for real, and small readers of what the company's
   summary looks like to a person over HTTP.

   The suites that use it declare their own `vi.mock` lines (vitest hoists them per file), see the header of
   spider-summary-resume-db.test.ts for the block to copy.
   ========================================================================== */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { testEnv } from '../test-env';

const BACKEND = path.resolve(__dirname, '..', '..', '..');

/** The email provider and the phone system as one small local server: the only boundary a stopped sweep reaches. */
export interface FakeProviders {
  /** Every email the provider was handed, in order. */
  emails: { to: string; id: string }[];
  /** Every text the phone system was handed, in order. */
  texts: { to: string }[];
  /** How long each answer takes (so a test can stop a sweep between two sends). */
  setDelay(ms: number): void;
  /** The environment that points a sweep process at this server (keys are made up at run time and never written down). */
  env: Record<string, string>;
}

export async function startFakeProviders(): Promise<FakeProviders> {
  let delay = 0;
  const providers: FakeProviders = { emails: [], texts: [], setDelay: (ms) => void (delay = ms), env: {} };
  const server = http.createServer((rq, rs) => {
    let body = '';
    rq.on('data', (d) => (body += d));
    rq.on('end', () => {
      const reply = (code: number, obj: unknown) =>
        setTimeout(() => {
          rs.writeHead(code, { 'content-type': 'application/json' });
          rs.end(JSON.stringify(obj));
        }, delay);
      const url = rq.url ?? '';
      if (rq.method === 'POST' && url.startsWith('/emails/batch')) {
        // One alert's or summary's emails come as one batch request (#3470): every message in it is recorded, in order.
        const batch = JSON.parse(body) as { to: string | string[] }[];
        const data = batch.map((m) => {
          const id = `em_${providers.emails.length + 1}`;
          providers.emails.push({ to: Array.isArray(m.to) ? m.to[0]! : m.to, id });
          return { id };
        });
        return reply(200, { data });
      }
      if (rq.method === 'POST' && url.startsWith('/emails')) {
        const m = JSON.parse(body) as { to: string | string[] };
        const id = `em_${providers.emails.length + 1}`;
        providers.emails.push({ to: Array.isArray(m.to) ? m.to[0]! : m.to, id });
        return reply(200, { id });
      }
      if (rq.method === 'GET' && /\/opt_out_texts/.test(url)) return reply(200, { opt_out_texts: [] });
      if (rq.method === 'POST' && /\/accounts\/[^/]+\/sms/.test(url)) {
        providers.texts.push({ to: new URLSearchParams(body).get('to') ?? '' });
        return reply(200, { id: `sms_${providers.texts.length}`, status: 'sent' });
      }
      reply(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  server.unref();
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const made = () => randomBytes(12).toString('hex');
  providers.env = { RESEND_API_KEY: `re_${made()}`, RESEND_BASE_URL: base, CTM_ACCESS_KEY: made(), CTM_SECRET_KEY: made(), CTM_API_BASE: base };
  return providers;
}

export interface SweepProcess {
  process: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
}

/**
 * A sweep in its own process (support/spider-sweep-child.ts) at this clock time; stop it with `process.kill`. Without
 * `providers` it has no email or phone provider key, so nothing it does can reach a provider.
 */
export function startSweepProcess(dbUrl: string, at: Date, providers?: FakeProviders): SweepProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'spider-sweep-child.ts'), at.toISOString()], {
    cwd: BACKEND,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      DATABASE_URL: dbUrl,
      SUPABASE_URL: testEnv.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: testEnv.SUPABASE_SERVICE_ROLE_KEY,
      FRONTEND_URL: 'https://staging.app.test',
      ...providers?.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d) => (output += String(d)));
  child.stderr?.on('data', (d) => (output += String(d)));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { process: child, exited, output: () => output };
}

/** Polls until `check` is true. Throws (with `what`) when `timeoutMs` passes. */
export async function waitUntil(check: () => Promise<boolean>, what: string, opts: { timeoutMs?: number; everyMs?: number } = {}): Promise<void> {
  const { timeoutMs = 120_000, everyMs = 5 } = opts;
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** The sweep's lease: a stopped process leaves its row, which a restart sees expire (2 minutes after its last renewal). */
export async function expireLease(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`UPDATE spider_sweep_leases SET expires_at = now() - interval '1 second' WHERE name = 'spider.sweep'`);
}

export async function clearLease(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`DELETE FROM spider_sweep_leases WHERE name = 'spider.sweep'`);
}

/**
 * A sweep covers every company with Spider settings, so a suite that built several would have each one's turn in every
 * run. Switches Spider off for every company but `org` (the way a company is off in production: its settings row says so).
 */
export async function onlyThisCompany(db: PrismaClient, org: string): Promise<void> {
  await db.spiderSettings.updateMany({ where: { organization_id: { not: org }, is_active: true }, data: { is_active: false } });
}

export const HISTORY = '/api/ai-farm/spider/history';
export const HISTORY_EXPORT = '/api/ai-farm/spider/history/export';
export const HISTORY_COUNT = '/api/ai-farm/spider/history/summary';
export const MY_SUMMARY = '/api/ai-farm/spider/summary';
export const COMPANY_SUMMARY = '/api/ai-farm/spider/summary/company';
export const BELL = '/api/notifications';
export const STATUS = '/api/ai-farm/spider/status';

type Api = { get(path: string): Promise<{ status: number; body: any }> }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What the company's Admin sees of the summary over HTTP: History's count and rows, the Spider page's card. */
export interface AdminView {
  historyTotal: number;
  historyItems: { in_starting_summary: boolean }[];
  countTotal: number;
  exportTotal: number;
  card: { id: string; total: number } | null;
}

export async function adminView(api: Api): Promise<AdminView> {
  const history = await api.get(`${HISTORY}?page_size=100`);
  const count = await api.get(HISTORY_COUNT);
  const exported = await api.get(HISTORY_EXPORT);
  const card = await api.get(COMPANY_SUMMARY);
  return {
    historyTotal: history.body.total as number,
    historyItems: history.body.items as { in_starting_summary: boolean }[],
    countTotal: count.body.total as number,
    exportTotal: exported.body.total as number,
    card: card.body.summary as { id: string; total: number } | null,
  };
}

/** What one person sees: their own summary page and the bell's starting-summary notices. */
export interface PersonView {
  mine: { id: string; total: number } | null;
  summaryNotices: { verb: string; title: string; data?: { lead_count?: number } }[];
  bellStatus: number;
}

export async function personView(api: Api): Promise<PersonView> {
  const mine = await api.get(MY_SUMMARY);
  const bell = await api.get(`${BELL}?limit=100`);
  const items = (bell.body.items ?? []) as { verb: string; title: string; data?: { lead_count?: number } }[];
  return {
    mine: mine.body.summary as { id: string; total: number } | null,
    summaryNotices: items.filter((n) => n.verb === 'spider.starting_summary'),
    bellStatus: bell.status,
  };
}

