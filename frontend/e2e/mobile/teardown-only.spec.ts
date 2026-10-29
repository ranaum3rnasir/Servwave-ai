import { test, expect } from '@playwright/test';
import fs from 'fs';
import { ORG_FILE } from './paths';
import { teardownLeftoverOrg } from './mobile-teardown';

/**
 * `npm run test:mobile:teardown` (mobile slice 62): tear down the throwaway org a killed run left
 * behind. A run whose Playwright process dies (an out-of-memory kill, a full disk, a closed laptop)
 * never reaches its global teardown, so the org stays on the staging database and its id stays in
 * e2e/.auth/e2e-org.json. This retries the same teardown the run would have done, and unlike the
 * global teardown it FAILS when the org is still there afterwards, so the command's exit code says.
 */
test('tear down the throwaway org a killed run left behind', async () => {
  test.setTimeout(900_000);
  if (!fs.existsSync(ORG_FILE)) {
    console.log('[mobile-gate] no leftover throwaway org is recorded: nothing to tear down');
    return;
  }
  const { torn, organizationId } = await teardownLeftoverOrg();
  expect(torn, `the throwaway org ${organizationId} is still on the staging database (see the lines above)`).toBe(true);
});
