import { describe, it, expect } from 'vitest';
import { AI_AGENTS } from './agents';
import {
  LIVE_AGENTS,
  NOT_AVAILABLE_COPY,
  accessibleAgentIdsFor,
  agentAccessibleFor,
  agentOnAccount,
  agentReleased,
  displayStatusFor,
} from './agentStatus';
import { isSpiderAdminUser } from '@/lib/spider/gate';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Ran, 13-14 Oct and 10 Nov: two facts decide every agent's status - is it on this company's account
// (the Available tag), and if so is it Active. The registry in agentStatus.ts is the only place that answers them; the card,
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

  it('is Spider for a pilot company, Active or Not active from the server, while Spider stays unreleased', () => {
    const read = (isActive: boolean) => ({ data: { isActive, isSetUp: true }, isError: false });
    expect(accessibleAgentIdsFor(PILOT_COMPANY)).toEqual(['spider']);
    const accessible = agentAccessibleFor('spider', PILOT_COMPANY);
    expect(displayStatusFor(accessible, read(true), agentReleased('spider'))).toBe('active');
    expect(displayStatusFor(accessible, read(false), agentReleased('spider'))).toBe('not_active');
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
  // The server's answer still carries whether Spider was set up; the status never reads it.
  const read = (isActive: boolean, isSetUp: boolean) => ({ data: { isActive, isSetUp }, isError: false });

  it('is Coming soon for an agent the company cannot use, whatever the server says', () => {
    expect(displayStatusFor(false, read(true, true))).toBe('coming_soon');
    expect(displayStatusFor(false, read(false, false))).toBe('coming_soon');
    expect(displayStatusFor(false, { data: undefined, isError: true })).toBe('coming_soon');
  });

  // Layer 1's other "no": released to customers, but not on this company's account.
  it('is Not available for a released agent the company cannot use, and released changes nothing for one it can', () => {
    expect(displayStatusFor(false, read(true, true), true)).toBe('not_available');
    expect(displayStatusFor(false, { data: undefined, isError: false }, true)).toBe('not_available');
    expect(displayStatusFor(true, read(true, true), true)).toBe('active');
    expect(displayStatusFor(true, read(false, false), true)).toBe('not_active');
  });

  // Ran, 10 Nov: Not active / Active from the server alone; set up or not never changes it.
  it('is Active or Not active from the server alone, set up or not', () => {
    expect(displayStatusFor(true, read(true, true))).toBe('active');
    expect(displayStatusFor(true, read(true, false))).toBe('active');
    expect(displayStatusFor(true, read(false, true))).toBe('not_active');
    expect(displayStatusFor(true, read(false, false))).toBe('not_active');
  });

  it('claims nothing while the status is being read, or when it cannot be read', () => {
    expect(displayStatusFor(true, { data: undefined, isError: false })).toBe('loading');
    expect(displayStatusFor(true, { data: undefined, isError: true })).toBe('unknown');
  });

  // The Available tag: on the account, whether or not it is running or read yet.
  it.each([
    ['coming_soon', false],
    ['not_available', false],
    ['active', true],
    ['not_active', true],
    ['loading', true],
    ['unknown', true],
  ] as const)('is on the account (Available) for %s: %s', (status, expected) => {
    expect(agentOnAccount(status)).toBe(expected);
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
  // Ran, 10 Nov: Not active / Active, no switch, and no "On, not set up yet" or "On, watching ...".
  it('never speak of a switch, of On / Off, of being set up, or of in development', () => {
    for (const [id, entry] of Object.entries(LIVE_AGENTS)) {
      const words = JSON.stringify(entry.copy);
      expect(words, id).not.toMatch(/\b(On|Off)\b/);
      expect(words, id).not.toMatch(/\bswitch|turn (it )?(on|off)|not set up|in development/i);
    }
  });

  it("are Spider's words from the mockup, word for word", () => {
    expect(LIVE_AGENTS.spider!.copy.notActiveHelp).toBe(
      'Spider watches nothing and sends nothing. Open it, check the settings, then press Activate.',
    );
    expect(LIVE_AGENTS.spider!.copy.deactivateWarning).toHaveLength(2);
  });
});

// Ran, 10 Nov (#3433): no switch anywhere for an agent. Activating happens only on the agent's own page,
// after its review; the AI Agentic Farm only reads the status and deactivates. A source sweep of the
// farm, so a switch or an activate call added there later fails here.
describe('the AI Agentic Farm has no switch and never activates an agent', () => {
  const SRC = join(process.cwd(), 'src');
  const FARM_DIRS = [join(SRC, 'components', 'ai-center'), join(SRC, 'lib', 'ai-center')];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  const farm = FARM_DIRS.flatMap(files);

  it('scans the farm', () => {
    const names = farm.map((f) => relative(SRC, f));
    expect(names).toContain(join('components', 'ai-center', 'AgentControls.tsx'));
    expect(names).toContain(join('components', 'ai-center', 'AgentCard.tsx'));
    expect(names).toContain(join('components', 'ai-center', 'AgentDetailModal.tsx'));
  });

  it.each(farm.map((f) => [relative(SRC, f), f]))('%s renders no switch and sends nothing to a status route', (_n, file) => {
    const code = readFileSync(file, 'utf8');
    expect(code).not.toMatch(/ui\/switch['"]/);
    expect(code).not.toMatch(/<Switch\b|role=["']switch["']/);
    expect(code).not.toMatch(/\/status['"`]/);
    expect(code).not.toMatch(/setActive\(\s*true\s*\)|mutate\(\s*true\s*\)/);
  });
});
