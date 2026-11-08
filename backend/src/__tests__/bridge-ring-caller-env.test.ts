// Mobile slice 21 - the bridge ring-first switch is env-only, so its parsing is
// part of the contract: default off, an unknown value refuses to boot (same as
// every other z.enum in env.ts), the live-disproven to_number refuses to boot
// with a message saying why, and the spike-scale agent map validates.
// Exercises the REAL env.ts (setup.ts mocks it for every other suite).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { bridgeAgentIdsSchema, bridgeRingCallerSchema } from '../config/bridgeRingCaller';

// env.ts calls dotenv.config(), which would refill unset vars from a local
// backend/.env and make these results depend on the machine. No-op it.
vi.mock('dotenv', () => ({ default: { config: vi.fn() }, config: vi.fn() }));

const USER_A = '00000000-0000-0000-0000-0000000000a1';
const USER_B = '00000000-0000-0000-0000-0000000000b2';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  SUPABASE_URL: 'https://test.example.com',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
};

async function loadRealEnv(extra: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...extra })) vi.stubEnv(k, v);
  const mod = await vi.importActual<typeof import('../config/env')>('../config/env');
  return mod.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('CTM_BRIDGE_RING_CALLER (real env.ts)', () => {
  it('defaults to off when unset', async () => {
    vi.stubEnv('CTM_BRIDGE_RING_CALLER', undefined as unknown as string);
    const env = await loadRealEnv({});
    expect(env.CTM_BRIDGE_RING_CALLER).toBe('off');
    expect(env.CTM_BRIDGE_AGENT_IDS.size).toBe(0);
  });

  it('reads a valid mode and the agent map', async () => {
    const env = await loadRealEnv({
      CTM_BRIDGE_RING_CALLER: 'to_agent',
      CTM_BRIDGE_AGENT_IDS: `${USER_A}=agent-1`,
    });
    expect(env.CTM_BRIDGE_RING_CALLER).toBe('to_agent');
    expect(env.CTM_BRIDGE_AGENT_IDS.get(USER_A)).toBe('agent-1');
  });

  it('boots with the proven call_number_caller mode', async () => {
    const env = await loadRealEnv({ CTM_BRIDGE_RING_CALLER: 'call_number_caller' });
    expect(env.CTM_BRIDGE_RING_CALLER).toBe('call_number_caller');
  });

  it('refuses to boot on to_number, saying it rings the customer first and what to use instead', async () => {
    await expect(loadRealEnv({ CTM_BRIDGE_RING_CALLER: 'to_number' })).rejects.toThrow(
      'CTM_BRIDGE_RING_CALLER=to_number rings the customer first (proven 2026-10-03); use call_number_caller',
    );
  });

  it('refuses to boot on an unknown mode', async () => {
    await expect(loadRealEnv({ CTM_BRIDGE_RING_CALLER: 'to-number' })).rejects.toThrow(/CTM_BRIDGE_RING_CALLER/);
  });
});

describe('bridgeRingCallerSchema', () => {
  it.each(['off', 'call_number_caller', 'to_number_user_id', 'to_agent'])('accepts %s', (v) => {
    expect(bridgeRingCallerSchema.parse(v)).toBe(v);
  });
  it('trims a pasted value', () => {
    expect(bridgeRingCallerSchema.parse(' call_number_caller ')).toBe('call_number_caller');
  });
  it('rejects to_number (disproven live) with a single clear issue, even when pasted with spaces', () => {
    const r = bridgeRingCallerSchema.safeParse(' to_number ');
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toEqual([
        'CTM_BRIDGE_RING_CALLER=to_number rings the customer first (proven 2026-10-03); use call_number_caller',
      ]);
    }
  });
  it('defaults to off', () => {
    expect(bridgeRingCallerSchema.parse(undefined)).toBe('off');
  });
  it('rejects an unknown value', () => {
    expect(bridgeRingCallerSchema.safeParse('on').success).toBe(false);
  });
});

describe('bridgeAgentIdsSchema', () => {
  it('parses a comma-separated uuid=agent map, tolerating spaces', () => {
    const map = bridgeAgentIdsSchema.parse(` ${USER_A}=agent-1 , ${USER_B}=AG_2 `);
    expect([...map.entries()]).toEqual([
      [USER_A, 'agent-1'],
      [USER_B, 'AG_2'],
    ]);
  });
  it('unset or blank is an empty map', () => {
    expect(bridgeAgentIdsSchema.parse(undefined).size).toBe(0);
    expect(bridgeAgentIdsSchema.parse('  ').size).toBe(0);
  });
  it.each([
    ['no separator', USER_A],
    ['not a uuid', 'tech-1=agent-1'],
    ['bad agent id', `${USER_A}=agent 1`],
    ['two separators', `${USER_A}=a=b`],
  ])('rejects an entry with %s, without echoing it', (_label, raw) => {
    const r = bridgeAgentIdsSchema.safeParse(raw);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).not.toContain('agent-1');
  });
});
