import { describe, it, expect } from 'vitest';
import { buildJobAgentTiles } from '@/components/jobs/AiJobAssistantBar';

describe('buildJobAgentTiles — job-aware suggestions', () => {
  it('always returns the five catalog agents', () => {
    const tiles = buildJobAgentTiles();
    expect(tiles.map((t) => t.id)).toEqual(['carlos', 'hannah', 'mike', 'emily', 'iris']);
  });

  it('weaves the job number, customer and service into the prompts', () => {
    const tiles = buildJobAgentTiles({
      jobNumber: 'J00051',
      customerName: 'Linda Allen',
      service: 'Access Control Installation',
      status: 'SCHEDULED',
    });
    const byId = Object.fromEntries(tiles.map((t) => [t.id, t.prompt]));

    // Every tile references the actual job, not generic copy.
    expect(tiles.every((t) => t.prompt.includes('J00051') || t.prompt.includes('Linda Allen'))).toBe(true);
    expect(byId.emily).toContain('Linda Allen');
    expect(byId.emily.toLowerCase()).toContain('access control installation');
    expect(byId.iris).toContain('J00051');
  });

  it('shifts the quality-audit copy to invoice-prep once the job is completed', () => {
    const scheduled = buildJobAgentTiles({ jobNumber: 'J00051', status: 'SCHEDULED' });
    const completed = buildJobAgentTiles({ jobNumber: 'J00051', customerName: 'Linda Allen', status: 'COMPLETED' });

    const carlosScheduled = scheduled.find((t) => t.id === 'carlos')!.prompt;
    const carlosCompleted = completed.find((t) => t.id === 'carlos')!.prompt;

    expect(carlosScheduled).toContain('invoice-ready');
    expect(carlosCompleted).toContain('before you invoice Linda Allen');
    expect(carlosScheduled).not.toEqual(carlosCompleted);
  });

  it('falls back to safe generic copy when context is missing', () => {
    const tiles = buildJobAgentTiles({});
    const byId = Object.fromEntries(tiles.map((t) => [t.id, t.prompt]));
    expect(byId.iris).toContain('this job');
    expect(byId.emily).toContain('the customer');
    // No leftover template artefacts.
    expect(tiles.every((t) => !t.prompt.includes('undefined') && !t.prompt.includes('${'))).toBe(true);
  });
});
