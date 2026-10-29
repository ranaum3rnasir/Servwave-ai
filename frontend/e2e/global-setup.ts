import { test as setup, expect, request } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authDir = path.resolve(__dirname, '.auth');
const authFile = path.join(authDir, 'admin.json');
const orgFile = path.join(authDir, 'e2e-org.json');
const BASE = process.env.E2E_BACKEND_URL || 'http://localhost:3000';

setup('provision throwaway org + authenticate', async ({ page }) => {
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const api = await request.newContext({ baseURL: BASE });

  // 1. Sweep any orphaned @e2e-qa.invalid users/orgs from a prior crashed run.
  await api.post('/api/test/teardown-org', { data: {} });

  // 2. Preflight: fail fast if the DB isn't post-D3 or the tax fixture drifted.
  const pre = await api.post('/api/test/preflight');
  expect(pre.status(), `preflight failed: ${await pre.text()}`).toBe(200);

  // 3. Provision a fresh org + admin.
  const provRes = await api.post('/api/test/provision-org');
  expect(provRes.status(), `provision failed: ${await provRes.text()}`).toBe(200);
  const prov = await provRes.json();
  fs.writeFileSync(orgFile, JSON.stringify(prov, null, 2));
  await api.dispose();

  // 4. Browser login as the PROVISIONED admin → storageState.
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  const email = page.locator('#email');
  await email.click();
  await email.pressSequentially(prov.adminEmail, { delay: 20 });
  const pw = page.locator('#password');
  await pw.click();
  await pw.pressSequentially(prov.adminPassword, { delay: 20 });
  // exact:true so we hit the password submit button, not the "Sign in with Google" button.
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
  await page.context().storageState({ path: authFile });
});
