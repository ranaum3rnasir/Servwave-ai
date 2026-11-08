import { request } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const orgFile = path.resolve(__dirname, '.auth', 'e2e-org.json');
const BASE = process.env.E2E_BACKEND_URL || 'http://localhost:3000';

/**
 * Tear down the throwaway org provisioned for this run (name-guarded Prisma purge) and
 * sweep all @e2e-qa.invalid Auth users. Wired into BOTH playwright configs as
 * `globalTeardown`. Best-effort — a failed teardown must never fail the suite.
 */
export default async function globalTeardown() {
  let organizationId: string | undefined;
  try {
    organizationId = JSON.parse(fs.readFileSync(orgFile, 'utf8')).organizationId;
  } catch {
    /* nothing to tear down */
  }
  const api = await request.newContext({ baseURL: BASE });
  await api.post('/api/test/teardown-org', { data: { organizationId } }).catch(() => {});
  await api.dispose();
  try {
    fs.rmSync(orgFile);
  } catch {
    /* ignore */
  }
}
