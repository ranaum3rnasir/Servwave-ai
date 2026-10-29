/**
 * The signed-in session the gate's specs share (moved here from gate.spec.ts so a targeted spec,
 * such as kpi-figures.spec.ts, signs in exactly the way the gate does and shares its slots).
 */
import { test as base, request, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ORG_FILE, SESSIONS_DIR, gateBackend } from './paths';

export interface Session { key: string; value: string; file: string }

/**
 * One login per worker SLOT (parallelIndex), not per worker process: Playwright replaces a worker
 * after every failed test, and a login per replacement trips the auth provider's sign-in limit.
 * The session the app refreshed is written back to the slot after each test, so the refresh-token
 * chain is never forked (a replayed refresh token revokes the session and signs later pages out).
 */
export const test = base.extend<object, { session: { current: Session } }>({
  session: [async ({}, use, workerInfo) => {
    const ref = new URL(supabaseUrl()).hostname.split('.')[0];
    const key = `sb-${ref}-auth-token`;
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const file = path.join(SESSIONS_DIR, `slot-${workerInfo.parallelIndex}.json`);
    let value: string;
    if (fs.existsSync(file)) {
      value = fs.readFileSync(file, 'utf8');
    } else {
      const org = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8'));
      const api = await request.newContext({ baseURL: gateBackend() });
      const res = await api.post('/api/auth/login', { data: { email: org.adminEmail, password: org.adminPassword } });
      const body = await res.json().catch(() => ({}));
      await api.dispose();
      if (!res.ok() || !body.session?.access_token) throw new Error(`gate login failed: ${res.status()} ${body.error ?? ''}`);
      value = JSON.stringify(body.session);
      fs.writeFileSync(file, value, { mode: 0o600 });
    }
    await use({ current: { key, value, file } });
  }, { scope: 'worker' }],
});

/** The localStorage key the app keeps its session under (the Lighthouse run seeds a profile with it). */
export function authStorageKey(): string {
  return `sb-${new URL(supabaseUrl()).hostname.split('.')[0]}-auth-token`;
}

/** The frontend's Supabase project URL, read from frontend/.env (the app's own config). */
export function supabaseUrl(): string {
  if (process.env.VITE_SUPABASE_URL) return process.env.VITE_SUPABASE_URL;
  const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
  const line = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith('VITE_SUPABASE_URL='));
  if (!line) throw new Error('VITE_SUPABASE_URL not found in frontend/.env');
  return line.slice('VITE_SUPABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
}

/**
 * Put this worker's session in localStorage before the app boots, and never let a sign-out reach
 * the auth service. The app signs out GLOBALLY when one /api/auth/me call fails (audit finding
 * F02); on a loaded machine that happens mid-run and kills every worker's session at once (it
 * would also sign out nobody else: this is the throwaway org's own admin).
 */
export async function signIn(page: Page, session: { current: Session }, notes: string[]) {
  const s = session.current;
  await page.context().addInitScript(({ k, v }) => {
    try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch { /* storage blocked */ }
  }, { k: s.key, v: s.value });
  await page.context().route(/\/auth\/v1\/logout/, (route) => {
    notes.push('blocked a sign-out request from the app');
    return route.abort('blockedbyclient');
  });
}

/** Carry the (possibly refreshed) session on to the next test in this worker. */
export async function keepSession(page: Page, session: { current: Session }) {
  const s = session.current;
  const v = await page.evaluate((k) => { try { return localStorage.getItem(k); } catch { return null; } }, s.key).catch(() => null);
  if (v && v !== s.value) {
    s.value = v;
    fs.writeFileSync(s.file, v, { mode: 0o600 });
  }
}
