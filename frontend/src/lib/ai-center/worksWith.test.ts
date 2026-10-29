import { describe, it, expect } from 'vitest';
import { AI_AGENTS } from './agents';
import { AGENT_WORKS_WITH, FARM_MODULES, worksWithFor } from './worksWith';

const copyOf = (id: string) => {
  const a = AI_AGENTS.find((x) => x.id === id)!;
  return [a.tagline, a.shortDescription, ...a.longDescription].join(' ');
};

describe('"Works with" in the agent detail modal', () => {
  it('has an entry for every agent, and nothing else', () => {
    expect(Object.keys(AGENT_WORKS_WITH).sort()).toEqual(AI_AGENTS.map((a) => a.id).sort());
  });

  it('gives every agent at least one ServWave module', () => {
    for (const agent of AI_AGENTS) expect(worksWithFor(agent).modules.length, agent.id).toBeGreaterThan(0);
  });

  // D4: the chips are the other animals the agent's own copy names, so a chip never claims a
  // partnership the copy does not.
  it('lists only teammates the agent copy names, never itself', () => {
    for (const [id, entry] of Object.entries(AGENT_WORKS_WITH)) {
      for (const other of entry.agents) {
        expect(other, id).not.toBe(id);
        const name = AI_AGENTS.find((a) => a.id === other)?.name;
        expect(name, `${id} -> ${other}`).toBeDefined();
        expect(copyOf(id), `${id} names ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
      }
    }
  });

  it('names ServWave modules in sentence case, never a third-party product', () => {
    const vendors = /quickbooks|xero|zapier|google|stripe|twilio|calltracking|ctm/i;
    for (const { label } of Object.values(FARM_MODULES)) {
      expect(label).not.toMatch(vendors);
      expect(label).toMatch(/^[A-Z][a-z ]+$/);
    }
  });
});
