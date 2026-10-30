// Payments slice 37b item 9: PAYMENTS_HIDE_LINK_ON_CARD set but empty reads as off (a hosting
// dashboard can save an empty value); anything unknown still refuses to boot.
// Exercises the REAL env.ts (setup.ts mocks it for every other suite).
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }));

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  SUPABASE_URL: 'https://test.example.com',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
};

async function loadRealEnv(value: string | undefined) {
  vi.resetModules();
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv('PAYMENTS_HIDE_LINK_ON_CARD', value as unknown as string);
  const mod = await vi.importActual<typeof import('../config/env')>('../config/env');
  return mod.env;
}

afterEach(() => vi.unstubAllEnvs());

describe('PAYMENTS_HIDE_LINK_ON_CARD (real env.ts)', () => {
  it.each([undefined, '', 'false', '0'])('%j is off', async (v) => {
    expect((await loadRealEnv(v)).PAYMENTS_HIDE_LINK_ON_CARD).toBe(false);
  });
  it.each(['true', '1'])('%j is on', async (v) => {
    expect((await loadRealEnv(v)).PAYMENTS_HIDE_LINK_ON_CARD).toBe(true);
  });
  it('anything else still fails loudly', async () => {
    await expect(loadRealEnv('maybe')).rejects.toThrow();
  });
});
