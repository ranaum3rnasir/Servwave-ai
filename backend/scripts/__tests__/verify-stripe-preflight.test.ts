import { describe, it, expect, vi } from 'vitest';

// The shared test setup stubs the stripe lib; the preflight only needs the pinned version string and
// the API address, so give it those without opening a real client.
vi.mock('../../src/lib/stripe', () => ({ STRIPE_API_VERSION: '2024-12-18.acacia' }));
vi.mock('../verify-stripe/sign', () => ({ API_URL: 'http://localhost:3139' }));

import { preflight, isProductionApiHost } from '../verify-stripe/preflight';
import { SkipFlow } from '../verify-stripe/context';
import { run as nightly } from '../verify-stripe/tests/nightly-reconcile';

const healthy = async () => ({ ok: true, status: 200 });
const sandbox = async () => ({ livemode: false });
const good = {
  secretKey: 'sk_test_abc',
  webhookSecret: 'whsec_abc',
  apiUrl: 'http://localhost:3139',
  fetchImpl: healthy,
  readBalance: sandbox,
};

describe('slice 39: the suite is sandbox only, with no override', () => {
  it('passes for a test key, a local backend and a sandbox balance read', async () => {
    const r = await preflight(good);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('refuses a secret key that is not a test key, even when live mode is asked for', async () => {
    const saved = process.argv;
    process.argv = [...saved, '--live', '--confirm-i-mean-it'];
    try {
      const r = await preflight({ ...good, secretKey: 'sk_live_abc' });
      expect(r.ok).toBe(false);
      expect(r.errors.join(' ')).toMatch(/sk_test_/);
    } finally {
      process.argv = saved;
    }
  });

  it('refuses a production API host, and allows localhost and the staging backend', async () => {
    for (const apiUrl of ['https://app.servwave.com', 'https://api.servwave.com', 'https://other.servwave.com', 'https://servwave.com']) {
      const r = await preflight({ ...good, apiUrl });
      expect(r.ok, apiUrl).toBe(false);
      expect(r.errors.join(' '), apiUrl).toMatch(/production host/);
    }
    for (const apiUrl of ['http://localhost:3139', 'http://127.0.0.1:3000', 'https://alpha-crm-test-env.onrender.com']) {
      expect(isProductionApiHost(apiUrl), apiUrl).toBe(false);
      expect((await preflight({ ...good, apiUrl })).ok, apiUrl).toBe(true);
    }
  });

  it('slice 40: an allow-list, not a deny-list - any host other than local or staging is refused, old production host included', async () => {
    for (const apiUrl of [
      'https://alpha-crm-1.onrender.com', 'https://example.com', 'https://staging.example', 'https://evil-alpha-crm-test-env.onrender.com',
      'https://alpha-crm-test-env.onrender.com.evil.example', 'not a url',
    ]) {
      expect(isProductionApiHost(apiUrl), apiUrl).toBe(true);
      const r = await preflight({ ...good, apiUrl });
      expect(r.ok, apiUrl).toBe(false);
      expect(r.errors.join(' '), apiUrl).toMatch(/production host/);
    }
    for (const apiUrl of ['http://localhost:3139', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://alpha-crm-test-env.onrender.com']) {
      expect(isProductionApiHost(apiUrl), apiUrl).toBe(false);
    }
  });

  it('never probes a production host', async () => {
    let probed = false;
    await preflight({ ...good, apiUrl: 'https://api.servwave.com', fetchImpl: async () => { probed = true; return { ok: true, status: 200 }; } });
    expect(probed).toBe(false);
  });

  it('refuses when the processor balance read says livemode', async () => {
    const r = await preflight({ ...good, readBalance: async () => ({ livemode: true }) });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/live mode/);
  });

  it('refuses when sandbox mode cannot be confirmed with the processor', async () => {
    const r = await preflight({ ...good, readBalance: async () => { throw new Error('network down'); } });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/could not confirm sandbox/);
  });
});

describe('slice 39: the nightly check', () => {
  it('skips, rather than passes, when this run booked nothing', async () => {
    const ctx = { apiUrl: 'http://localhost:3139', stripe: {} as any, chargingAccount: 'acct_test', booked: [] };
    await expect(nightly(ctx, { verbose: false })).rejects.toBeInstanceOf(SkipFlow);
  });
});
