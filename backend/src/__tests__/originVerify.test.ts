import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { originVerify } from '../middleware/originVerify';
import { logger } from '../lib/logger';

// The shared secret Cloudflare would inject on every forwarded request.
const SECRET = 'cf-shared-secret-abc123';

// Minimal app that mounts ONLY the middleware under test, then a catch-all that
// returns 200. The catch-all is reached only if originVerify calls next(), so a
// 200 means "allowed through" and a 403 means "rejected" — behaviour observed
// purely through the public HTTP interface.
function makeApp() {
  const app = express();
  app.use(originVerify);
  app.use((_req, res) => res.json({ ok: true }));
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('originVerify middleware', () => {
  it('allows a request carrying the correct X-Origin-Verify header', async () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const res = await request(makeApp()).get('/api/customers').set('X-Origin-Verify', SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects a request with the wrong secret (403 Forbidden)', async () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const res = await request(makeApp()).get('/api/customers').set('X-Origin-Verify', 'not-the-secret');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('rejects a request missing the header entirely (403 Forbidden)', async () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const res = await request(makeApp()).get('/api/customers');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('does not throw / does not leak on a header of a different length than the secret', async () => {
    // crypto.timingSafeEqual throws on length-mismatched buffers; the impl must
    // not crash (500) when the attacker sends a short/long value — it must 403.
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const res = await request(makeApp()).get('/api/customers').set('X-Origin-Verify', 'x');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('exempts /api/webhooks/* paths even with no header', async () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const res = await request(makeApp()).post('/api/webhooks/stripe');
    expect(res.status).toBe(200);
  });

  it('exempts the /health check even with no header', async () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const res = await request(makeApp()).get('/health');
    expect(res.status).toBe(200);
  });

  it('does NOT exempt a lookalike path like /api/webhooks-fake', async () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', SECRET);
    const res = await request(makeApp()).get('/api/webhooks-fake');
    expect(res.status).toBe(403);
  });

  it('fail-open: allows traffic through (and warns) when ORIGIN_VERIFY_SECRET is unset', async () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', '');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const res = await request(makeApp()).get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
  });
});
