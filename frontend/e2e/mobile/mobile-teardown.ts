import { request } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { PURGE_BLOCKERS, clearPurgeBlockers as clearBlockers, teardownWithRetries } from '../../scripts/mobile-sweep-lib.mjs';
import { AUTH_DIR, FIXTURES_FILE, ORG_FILE, SESSIONS_DIR, VISUAL_FIXTURES_FILE, gateBackend } from './paths';

/** Orgs a teardown could not remove (id and time, one per line): for whoever cleans up the staging database. */
export const LEAKED_ORGS_FILE = path.join(AUTH_DIR, 'leaked-orgs.txt');

type OrgFile = { organizationId: string; adminEmail: string; adminPassword: string };

/**
 * Delete what the purge cannot (PURGE_BLOCKERS in scripts/mobile-sweep-lib.mjs), as the throwaway admin.
 *
 * Says why when it cannot finish (a failed admin login used to return quietly and leave the rates
 * behind) and never reports ok while a record remains.
 */
async function clearPurgeBlockers(org: OrgFile): Promise<{ ok: boolean; deleted: number; reason?: string }> {
  const anon = await request.newContext({ baseURL: gateBackend() });
  try {
    const login = await anon.post('/api/auth/login', { data: { email: org.adminEmail, password: org.adminPassword } });
    const token = (await login.json().catch(() => ({})))?.session?.access_token;
    if (!login.ok() || !token) return { ok: false, deleted: 0, reason: `the throwaway admin's login answered ${login.status()}` };
    const api = await request.newContext({ baseURL: gateBackend(), extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
    try {
      return await clearBlockers(api, PURGE_BLOCKERS);
    } finally {
      await api.dispose();
    }
  } finally {
    await anon.dispose();
  }
}

/**
 * Tear down the throwaway org recorded in e2e-org.json and ONLY its own Auth users
 * (`auth_sweep: 'org'`), so a gate run in another worktree keeps its admin. Retries (each time
 * clearing the tax rates again) and logs every attempt. On success the run's files are removed.
 * On failure the org file is KEPT, so `npm run test:mobile:teardown`, or the next run's start, can
 * try again, and the org id is appended to leaked-orgs.txt and printed. Returns the leaked org id.
 */
export async function teardownLeftoverOrg(): Promise<{ torn: boolean; organizationId?: string }> {
  let org: OrgFile;
  try {
    org = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8'));
  } catch {
    return { torn: true }; // nothing provisioned (self-test only runs), or already torn down
  }
  const organizationId = org.organizationId;
  const api = await request.newContext({ baseURL: gateBackend() });
  let result;
  try {
    result = await teardownWithRetries({
      deleteRates: () => clearPurgeBlockers(org),
      teardownOrg: async () => {
        const res = await api.post('/api/test/teardown-org', { data: { organizationId, auth_sweep: 'org' }, timeout: 300_000 });
        return { ok: res.ok(), status: res.status(), body: await res.text() };
      },
      log: (m: string) => console.log(`[mobile-gate] teardown of ${organizationId}: ${m}`),
    });
  } finally {
    await api.dispose();
  }
  if (result.ok) {
    console.log(`[mobile-gate] teardown of ${organizationId}: done (${result.attempts} attempt${result.attempts === 1 ? '' : 's'})`);
    for (const f of [ORG_FILE, FIXTURES_FILE, VISUAL_FIXTURES_FILE, SESSIONS_DIR]) fs.rmSync(f, { recursive: true, force: true });
    try {
      // A retry that works takes the org off the leak list: what is left there is still on staging.
      const kept = fs.readFileSync(LEAKED_ORGS_FILE, 'utf8').split('\n').filter((l) => l && !l.includes(organizationId));
      fs.writeFileSync(LEAKED_ORGS_FILE, kept.length ? `${kept.join('\n')}\n` : '');
    } catch {
      /* no leak list */
    }
    return { torn: true, organizationId };
  }
  console.log(`[mobile-gate] LEAKED ORG ${organizationId}: teardown failed after ${result.attempts} attempts (${result.status} ${String(result.body).slice(0, 200)}). Retry with \`npm run test:mobile:teardown\`.`);
  try {
    fs.appendFileSync(LEAKED_ORGS_FILE, `${new Date().toISOString()} ${organizationId} ${result.status}\n`);
  } catch {
    /* the console line above is the record */
  }
  return { torn: false, organizationId };
}

/**
 * The run's global teardown. Best-effort: a failed teardown never fails the run, but it says so
 * (a leaked org stays on staging until someone sweeps it).
 */
export default async function mobileTeardown() {
  if (process.env.MOBILE_GATE_SERVERS === 'off') return; // self-test runs provision nothing
  if (process.env.MOBILE_GATE_KEEP_ORG === '1') {
    console.log('[mobile-gate] MOBILE_GATE_KEEP_ORG=1: throwaway org kept for debugging');
    return;
  }
  try {
    await teardownLeftoverOrg();
  } catch (err) {
    console.log(`[mobile-gate] teardown FAILED, org left behind (its id is in ${ORG_FILE}): ${String(err)}`);
  }
}
