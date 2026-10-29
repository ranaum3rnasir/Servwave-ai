/**
 * POST /api/test/teardown-org passes the caller's Auth-sweep scope through.
 *
 * The mobile gate (frontend/e2e/mobile) tears its throwaway org down with
 * `{ organizationId, auth_sweep: 'org' }` so that a run in one worktree never deletes the admin of
 * a run in another. Any other value keeps the historical full-domain sweep.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const { teardownTestOrg } = vi.hoisted(() => ({
  teardownTestOrg: vi.fn(async (_orgId?: string, _opts?: unknown) => {}),
}));
vi.mock('../lib/e2e-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/e2e-org')>();
  return { ...actual, teardownTestOrg };
});

import app from '../app';
import { env } from '../config/env';

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalFlag = env.E2E_TEST_DOORS;

beforeEach(() => {
  teardownTestOrg.mockClear();
  (env as any).E2E_TEST_DOORS = 'true';
});

afterEach(() => {
  (env as any).E2E_TEST_DOORS = originalFlag;
});

describe('POST /api/test/teardown-org - auth_sweep', () => {
  it("passes authSweep 'org' through when the body asks for it", async () => {
    const res = await request(app)
      .post('/api/test/teardown-org')
      .send({ organizationId: 'org-1', auth_sweep: 'org' });
    expect(res.status).toBe(200);
    expect(teardownTestOrg).toHaveBeenCalledWith('org-1', { authSweep: 'org' });
  });

  it("keeps the full sweep ('all') when the body does not ask, or asks for anything else", async () => {
    await request(app).post('/api/test/teardown-org').send({ organizationId: 'org-1' });
    await request(app).post('/api/test/teardown-org').send({ organizationId: 'org-1', auth_sweep: 'everyone' });
    expect(teardownTestOrg).toHaveBeenNthCalledWith(1, 'org-1', { authSweep: 'all' });
    expect(teardownTestOrg).toHaveBeenNthCalledWith(2, 'org-1', { authSweep: 'all' });
  });

  it('stays closed when E2E_TEST_DOORS is off', async () => {
    (env as any).E2E_TEST_DOORS = 'false';
    const res = await request(app)
      .post('/api/test/teardown-org')
      .send({ organizationId: 'org-1', auth_sweep: 'org' });
    expect(res.status).toBe(403);
    expect(teardownTestOrg).not.toHaveBeenCalled();
  });
});
