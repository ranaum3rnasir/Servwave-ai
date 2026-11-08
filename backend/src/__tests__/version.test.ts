import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { env } from '../config/env';
import { mockAuthAs, authHeader } from './helpers';

// `env` is parsed once at import time, so the platform variables cannot be
// exercised through process.env from here — the object itself is the seam.
const mutableEnv = env as { RENDER_GIT_COMMIT?: string; RENDER_GIT_BRANCH?: string };

describe('GET /api/version', () => {
  const original = {
    commit: env.RENDER_GIT_COMMIT,
    branch: env.RENDER_GIT_BRANCH,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mutableEnv.RENDER_GIT_COMMIT = original.commit;
    mutableEnv.RENDER_GIT_BRANCH = original.branch;
  });

  // The load-bearing decision on this route. /health is public because the
  // platform probe hits the origin directly; this deliberately does not inherit
  // that exemption, so build identity is not readable by anonymous callers.
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(401);
  });

  it('reports the full commit SHA and branch the platform injected', async () => {
    mockAuthAs('admin');
    mutableEnv.RENDER_GIT_COMMIT = '235ec8fa26d6c06e971d5ad1cc43798f278096e6';
    mutableEnv.RENDER_GIT_BRANCH = 'main';

    const res = await request(app).get('/api/version').set(authHeader('admin'));

    expect(res.status).toBe(200);
    // Never shortened: the caller settles "is commit X live?" with an ancestry
    // test against this value, not string equality.
    expect(res.body.commit).toBe('235ec8fa26d6c06e971d5ad1cc43798f278096e6');
    expect(res.body.branch).toBe('main');
  });

  // Absent locally and in CI. Reporting null keeps "we do not know" distinguishable
  // from a real answer — a placeholder would read as a genuine deploy and make the
  // endpoint worse than not having one.
  it('reports null rather than a placeholder when the platform injected nothing', async () => {
    mockAuthAs('admin');
    delete mutableEnv.RENDER_GIT_COMMIT;
    delete mutableEnv.RENDER_GIT_BRANCH;

    const res = await request(app).get('/api/version').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.commit).toBeNull();
    expect(res.body.branch).toBeNull();
  });
});
