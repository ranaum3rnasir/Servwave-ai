import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(__dirname, '..', '.auth');

export { AUTH_DIR };
/** The provisioned org + admin. Also read by helpers/api-client.ts (provisionedAdmin). */
export const ORG_FILE = path.join(AUTH_DIR, 'e2e-org.json');
/** The seeded record ids and public tokens the key routes open. */
export const FIXTURES_FILE = path.join(AUTH_DIR, 'mobile-fixtures.json');
/** The fixed-literal records the phone visual baselines photograph (visual-setup.ts; slice 74). */
export const VISUAL_FIXTURES_FILE = path.join(AUTH_DIR, 'mobile-visual-fixtures.json');
/** Signed-in sessions, one per worker slot (credentials: under the gitignored .auth/). */
export const SESSIONS_DIR = path.join(AUTH_DIR, 'mobile-sessions');
/** The backend the gate talks to; playwright.mobile.config.ts sets it. */
export const gateBackend = () => {
  const url = process.env.E2E_BACKEND_URL;
  if (!url) throw new Error('E2E_BACKEND_URL is unset: run the gate through e2e/playwright.mobile.config.ts');
  return url;
};
