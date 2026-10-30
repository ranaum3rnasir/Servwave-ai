import { describe, it, expect } from 'vitest';
import { AI_AGENTS } from './agents';
import {
  LIVE_AGENTS,
  NOT_AVAILABLE_COPY,
  accessibleAgentIdsFor,
  agentAccessibleFor,
  agentIsSetUp,
  agentReleased,
  displayStatusFor,
} from './agentStatus';
import { isSpiderAdminUser } from '@/lib/spider/gate';

// Ran, 13-14 Oct: two questions decide every agent's status - is it open to this company, and if so
// is it switched on. The registry in agentStatus.ts is the only place that answers them; the card,
// the detail modal and the header count all read it.

const SPIDER_COMPANY = { org_features: ['leads', 'spider'], org_is_demo: true };
// SPEC-5: a real (non-demo) company on the server's Spider pilot list.
const PILOT_COMPANY = { org_features: ['leads', 'spider'], org_is_demo: false, org_is_spider_pilot: true };

describe('which agents a company can use', () => {
  it('is Spider alone for a company that passes the Spider gate', () => {
    expect(accessibleAgentIdsFor(SPIDER_COMPANY)).toEqual(['spider']);
    expect(agentAccessibleFor('spider', SPIDER_COMPANY)).toBe(true);
  });

  it.each([
    ['without the spider feature', { org_features: ['leads'], org_is_demo: true }],
    ['that is not a demo company', { org_features: ['spider'], org_is_demo: false }],
    ['with no flags at all (an old cached session)', {}],
    ['when nobody is signed in', null],
  ])('is nothing for a company %s', (_label, user) => {
    expect(accessibleAgentIdsFor(user)).toEqual([]);
    expect(agentAccessibleFor('spider', user)).toBe(false);
  });

  it('is Spider for a pilot company, On or Off from its switch, while Spider stays unreleased', () => {
    const read = (isActive: boolean) => ({ data: { isActive, isSetUp: true }, isError: false });
    expect(accessibleAgentIdsFor(PILOT_COMPANY)).toEqual(['spider']);
    const accessible = agentAccessibleFor('spider', PILOT_COMPANY);
    expect(displayStatusFor(accessible, read(true), agentReleased('spider'))).toBe('on');
    expect(displayStatusFor(accessible, read(false), agentReleased('spider'))).toBe('off');
    expect(agentReleased('spider')).toBe(false);
  });

  it('keeps every other agent closed, even at a Spider company', () => {
    const others = AI_AGENTS.filter((a) => a.id !== 'spider');
    expect(others.length).toBeGreaterThan(0);
    for (const a of others) expect(agentAccessibleFor(a.id, SPIDER_COMPANY), a.id).toBe(false);
  });

  it('only ever names agents that are in the catalog', () => {
    const ids = new Set(AI_AGENTS.map((a) => a.id));
    for (const id of Object.keys(LIVE_AGENTS)) expect(ids.has(id), id).toBe(true);
  });
});

describe('the status an agent shows', () => {
  const read = (isActive: boolean, isSetUp: boolean) => ({ data: { isActive, isSetUp }, isError: false });

  it('is Coming soon for an agent the company cannot use, whatever its switch says', () => {
    expect(displayStatusFor(false, read(true, true))).toBe('coming_soon');
    expect(displayStatusFor(false, read(false, false))).toBe('coming_soon');
    expect(displayStatusFor(false, { data: undefined, isError: true })).toBe('coming_soon');
  });

  // Layer 1's other "no": released to customers, but not on this company's account.
  it('is Not available for a released agent the company cannot use, and released changes nothing for one it can', () => {
    expect(displayStatusFor(false, read(true, true), true)).toBe('not_available');
    expect(displayStatusFor(false, { data: undefined, isError: false }, true)).toBe('not_available');
    expect(displayStatusFor(true, read(true, true), true)).toBe('on');
    expect(displayStatusFor(true, read(false, false), true)).toBe('off');
  });

  it('is On or Off from the switch for an agent the company can use', () => {
    expect(displayStatusFor(true, read(true, true))).toBe('on');
    expect(displayStatusFor(true, read(false, true))).toBe('off');
  });

  // Ran, 14 Oct: the switch says whether the agent is applied, set up or not. Setup is carried
  // beside it, never instead of it, so an agent switched on before it is set up still reads On.
  it('is On or Off from the switch alone, whether or not the agent was set up', () => {
    expect(displayStatusFor(true, read(true, false))).toBe('on');
    expect(displayStatusFor(true, read(false, false))).toBe('off');
  });

  it('carries whether the agent was set up beside the switch, and says no unless it was read', () => {
    expect(agentIsSetUp(true, read(true, true))).toBe(true);
    expect(agentIsSetUp(true, read(false, true))).toBe(true);
    expect(agentIsSetUp(true, read(true, false))).toBe(false);
    expect(agentIsSetUp(true, read(false, false))).toBe(false);
    expect(agentIsSetUp(true, { data: undefined, isError: false })).toBe(false);
    expect(agentIsSetUp(true, { data: undefined, isError: true })).toBe(false);
    // A company that cannot use the agent never hears it is set up.
    expect(agentIsSetUp(false, read(true, true))).toBe(false);
  });

  it('claims nothing while the switch is being read, or when it cannot be read', () => {
    expect(displayStatusFor(true, { data: undefined, isError: false })).toBe('loading');
    expect(displayStatusFor(true, { data: undefined, isError: true })).toBe('unknown');
  });
});

describe('who may manage Spider', () => {
  // The same check production uses (useIsSpiderAdmin): an Admin. The registry reuses it.
  it.each([
    ['an Admin', { role: 'ADMIN', is_admin: true }, true],
    ['a Sales user', { role: 'SALES', is_admin: false }, false],
    ['a Technician', { role: 'TECHNICIAN', is_admin: false }, false],
    ['nobody', null, false],
  ])('%s', (_label, user, expected) => {
    expect(isSpiderAdminUser(user)).toBe(expected);
  });

  // Spider's launch is demo-only, so it has not gone to customers: everyone outside the gate keeps
  // seeing "Coming soon", never "Not on your account yet".
  it('is not released yet, so a company outside the gate sees Coming soon', () => {
    expect(LIVE_AGENTS.spider!.released).toBe(false);
    expect(agentReleased('spider')).toBe(false);
    expect(agentReleased('mike')).toBe(false);
    expect(agentReleased(null)).toBe(false);
  });

  it('is the check the Spider registry entry uses, managed on its own page', () => {
    const spider = LIVE_AGENTS.spider!;
    expect(spider.canManage).toBe(isSpiderAdminUser);
    expect(spider.managePath).toBe('/spider');
  });
});

describe('the words for a released agent a company does not have', () => {
  it('are the same for every agent, and never name a plan or a tier', () => {
    expect(NOT_AVAILABLE_COPY.title('Spider')).toBe('Spider is not on your account yet');
    expect(NOT_AVAILABLE_COPY.title('Falcon')).toBe('Falcon is not on your account yet');
    const words = [NOT_AVAILABLE_COPY.card, NOT_AVAILABLE_COPY.title('X'), NOT_AVAILABLE_COPY.detail, NOT_AVAILABLE_COPY.book].join(' ');
    expect(words).not.toMatch(/\b(plan|tier|upgrade|scale|pro|pay|price)\b/i);
  });
});

describe('the words an agent brings', () => {
  // Ran, 14 Oct: On / Off everywhere, never "Active", and no "in development".
  it('never say Active or in development', () => {
    for (const [id, entry] of Object.entries(LIVE_AGENTS)) {
      const words = JSON.stringify(entry.copy);
      expect(words, id).not.toMatch(/\bactive\b/i);
      expect(words, id).not.toMatch(/in development/i);
    }
  });
});
