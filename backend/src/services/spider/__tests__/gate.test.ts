/**
 * SPEC-5: Spider for demo companies plus the companies on the pilot list (SPIDER_PILOT_ORG_IDS).
 * Every id here is made up. The list is set on the mocked env (setup.ts leaves it unset, which is
 * today's behaviour) and restored after each test.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../../config/env';
import { spiderAvailable, spiderAvailableForOrg, spiderPilotListBootLine, spiderPilotOrgIds } from '../gate';

const PILOT = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const mutableEnv = env as { SPIDER_PILOT_ORG_IDS?: string };
const before = mutableEnv.SPIDER_PILOT_ORG_IDS;
afterEach(() => {
  mutableEnv.SPIDER_PILOT_ORG_IDS = before;
});
function setList(value: string | undefined): void {
  mutableEnv.SPIDER_PILOT_ORG_IDS = value;
}

describe('spiderPilotOrgIds', () => {
  it('is empty when the setting is unset', () => {
    setList(undefined);
    expect(spiderPilotOrgIds()).toEqual([]);
  });

  it.each(['', '  ', ' , ,'])('is empty for a blank setting (%j)', (value) => {
    setList(value);
    expect(spiderPilotOrgIds()).toEqual([]);
  });

  it('trims, lowercases and drops blank entries', () => {
    setList(' A1 , ,b2 ');
    expect(spiderPilotOrgIds()).toEqual(['a1', 'b2']);
  });
});

describe('spiderPilotListBootLine', () => {
  it('gives the count of listed companies and never an id', () => {
    setList(`${PILOT}, ${OTHER}`);
    const line = spiderPilotListBootLine();
    expect(line).toBe('Spider pilot list: 2 companies');
    expect(line).not.toContain(PILOT);
  });

  it('says 0 companies when the list is unset', () => {
    setList(undefined);
    expect(spiderPilotListBootLine()).toBe('Spider pilot list: 0 companies');
  });
});

describe('spiderAvailable', () => {
  const withSpider = ['leads', 'spider'];

  it('opens for a demo company with the feature (unchanged)', () => {
    expect(spiderAvailable({ features: withSpider, isDemo: true, orgId: OTHER })).toBe(true);
  });

  it('opens for a listed non-demo company with the feature', () => {
    setList(PILOT);
    expect(spiderAvailable({ features: withSpider, isDemo: false, orgId: PILOT })).toBe(true);
  });

  it('stays shut for a non-demo company when the list holds another id', () => {
    setList(OTHER);
    expect(spiderAvailable({ features: withSpider, isDemo: false, orgId: PILOT })).toBe(false);
  });

  it('stays shut for a non-demo company when the list is unset', () => {
    setList(undefined);
    expect(spiderAvailable({ features: withSpider, isDemo: false, orgId: PILOT })).toBe(false);
  });

  it('stays shut for a listed company without the feature', () => {
    setList(PILOT);
    expect(spiderAvailable({ features: ['leads'], isDemo: false, orgId: PILOT })).toBe(false);
  });

  it('stays shut when the company id is missing', () => {
    setList(PILOT);
    expect(spiderAvailable({ features: withSpider, isDemo: false, orgId: undefined })).toBe(false);
  });

  it('matches regardless of case', () => {
    setList(PILOT.toUpperCase());
    expect(spiderAvailable({ features: withSpider, isDemo: false, orgId: PILOT })).toBe(true);
  });
});

describe('spiderAvailableForOrg', () => {
  const org = (over: Partial<{ id: string; plan: string; trial_ends_at: Date | null; feature_overrides: unknown }> = {}) => ({
    id: PILOT,
    is_demo: false,
    plan: 'SCALE',
    trial_ends_at: null,
    feature_overrides: {},
    ...over,
  });

  it('opens for a listed company on Scale', () => {
    setList(PILOT);
    expect(spiderAvailableForOrg(org())).toBe(true);
  });

  it('stays shut for a listed company on Pro', () => {
    setList(PILOT);
    expect(spiderAvailableForOrg(org({ plan: 'PRO' }))).toBe(false);
  });

  it('opens for a listed company on Pro with the feature switched on for it', () => {
    setList(PILOT);
    expect(spiderAvailableForOrg(org({ plan: 'PRO', feature_overrides: { spider: true } }))).toBe(true);
  });

  it('stays shut for a listed company on Scale with the feature switched off for it', () => {
    setList(PILOT);
    expect(spiderAvailableForOrg(org({ feature_overrides: { spider: false } }))).toBe(false);
  });

  it('opens for a listed company on an active trial', () => {
    setList(PILOT);
    expect(spiderAvailableForOrg(org({ plan: 'STARTER', trial_ends_at: new Date(Date.now() + 7 * 86_400_000) }))).toBe(true);
  });

  it('stays shut for an unlisted non-demo company on Scale', () => {
    setList(OTHER);
    expect(spiderAvailableForOrg(org())).toBe(false);
  });
});

describe('the gate source', () => {
  it('holds no company id (no default list)', () => {
    const source = readFileSync(join(__dirname, '..', 'gate.ts'), 'utf8');
    expect(source).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
  });
});
