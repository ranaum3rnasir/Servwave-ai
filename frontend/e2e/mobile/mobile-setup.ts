import { test as setup, expect, request } from '@playwright/test';
import fs from 'fs';
import { ApiClient } from '../helpers/api-client';
import { seedGateFixtures } from './seed';
import { AUTH_DIR, FIXTURES_FILE, ORG_FILE, SESSIONS_DIR, gateBackend } from './paths';
import { RECORDS_DIR } from './allowlist';
import { writeSweepPlan } from './sweep-plan';
import { teardownLeftoverOrg } from './mobile-teardown';

const BASE = gateBackend();

/**
 * Provision a fresh throwaway org (`e2e-qa-<run>`, `@e2e-qa.invalid` users) and seed the records
 * the key routes open. Unlike global-setup.ts this does NOT start with the full Auth-user sweep:
 * other gate runs in other worktrees may be live, and that sweep deletes their admin.
 */
setup('provision a throwaway org and seed the key-route records', async () => {
  setup.setTimeout(300_000);
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  // A run that was killed before its teardown (the runner dies, the laptop sleeps, a full disk)
  // leaves its org recorded in e2e-org.json, and provisioning below would overwrite that record and
  // leak the org for good. Tear it down first; if that fails too, its id is in leaked-orgs.txt.
  if (fs.existsSync(ORG_FILE)) {
    console.log('[mobile-gate] a previous run left its throwaway org behind; tearing it down first');
    await teardownLeftoverOrg().catch((err) => console.log(`[mobile-gate] could not tear the earlier org down (${String(err)}); its id is in ${ORG_FILE}`));
  }
  writeSweepPlan(); // the full sweep only: what the sweep report must find in the results (slice 62)
  fs.rmSync(RECORDS_DIR, { recursive: true, force: true }); // records describe ONE run
  fs.rmSync(SESSIONS_DIR, { recursive: true, force: true }); // sessions belong to ONE org

  const api0 = await request.newContext({ baseURL: BASE });
  const pre = await api0.post('/api/test/preflight');
  expect(pre.status(), `preflight failed (is the doored API up on ${BASE}?): ${await pre.text()}`).toBe(200);
  const prov = await api0.post('/api/test/provision-org');
  const provBody = await prov.text();
  expect(prov.status(), `provision failed: ${provBody}`).toBe(200);
  await api0.dispose();
  fs.writeFileSync(ORG_FILE, provBody);
  const org = JSON.parse(provBody) as { organizationId: string };

  const api = await new ApiClient().init();
  try {
    const fixtures = await seedGateFixtures(api, org.organizationId);
    for (const [k, v] of Object.entries(fixtures)) {
      if (typeof v === 'string') expect(v, `fixture ${k}`).toBeTruthy();
      else expect(v.id && v.token, `fixture ${k} needs an id and a public token`).toBeTruthy();
    }
    fs.writeFileSync(FIXTURES_FILE, JSON.stringify(fixtures, null, 2));
  } finally {
    await api.dispose();
  }
});
