import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';

// This named test IS the production-trust guarantee (§11): it proves that in
// production the real /api/webhooks/stripe route still rejects an unsigned event
// (signature trust intact) and the /api/test/* door does not exist — even with
// E2E_TEST_DOORS=true. The test door block + assertNoTestRoutesInProduction()
// both key off process.env.NODE_ENV, which vi.stubEnv controls directly.
describe('production webhook trust (regression)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('prod rejects unsigned webhook 400 and exposes no test door, even with E2E_TEST_DOORS=true', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_TEST_DOORS', 'true');
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@db.example.com:6543/postgres?sslmode=require');
    vi.stubEnv('DIRECT_URL', 'postgresql://u:p@db.example.com:5432/postgres?sslmode=require');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test');
    vi.resetModules();

    // NodeNext types the dynamic-import namespace's `default` as the CJS module record,
    // so cast to the exact type request() accepts (runtime default is the Express app).
    const app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];

    // The test door must NOT be registered in production.
    const door = await request(app)
      .post('/api/test/stripe-webhook')
      .send({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } });
    expect(door.status).toBe(404);

    // Same guarantee for the CTM door: absent in production even with the flag on.
    const ctmDoor = await request(app)
      .post('/api/test/ctm-webhook')
      .send({ position: 'end', payload: { sid: 'CA_x', account_id: '500001' } });
    expect(ctmDoor.status).toBe(404);

    // The real route still demands a signature → 400 (signature missing).
    const real = await request(app)
      .post('/api/webhooks/stripe')
      .set('content-type', 'application/json')
      .send(Buffer.from(JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: {} } })));
    expect(real.status).toBe(400);
  });
});
