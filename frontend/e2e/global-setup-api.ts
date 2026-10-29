import { request } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authDir = path.resolve(__dirname, '.auth');
const orgFile = path.join(authDir, 'e2e-org.json');
const BASE = 'http://localhost:3000';

/**
 * Backend-tier (`playwright.api.config.ts`) globalSetup. The API config has no `setup`
 * project (no browser login is needed for HTTP tests), so this mirrors the browser
 * config's steps 1-3 without the storageState login: sweep orphans → preflight →
 * provision a fresh throwaway org → persist `.auth/e2e-org.json` (the file
 * `provisionedAdmin()` reads to authenticate `ApiClient.init()`).
 */
export default async function globalSetupApi() {
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const api = await request.newContext({ baseURL: BASE });

  // 1. Sweep any orphaned @e2e-qa.invalid users/orgs from a prior crashed run.
  await api.post('/api/test/teardown-org', { data: {} });

  // 2. Preflight: fail fast if the DB isn't post-D3 or the tax fixture drifted.
  const pre = await api.post('/api/test/preflight');
  if (pre.status() !== 200) {
    await api.dispose();
    throw new Error(`preflight failed (${pre.status()}): ${await pre.text()}`);
  }

  // 3. Provision a fresh org + admin and persist for ApiClient.init().
  const provRes = await api.post('/api/test/provision-org');
  if (provRes.status() !== 200) {
    await api.dispose();
    throw new Error(`provision failed (${provRes.status()}): ${await provRes.text()}`);
  }
  const prov = await provRes.json();
  fs.writeFileSync(orgFile, JSON.stringify(prov, null, 2));
  await api.dispose();
}
