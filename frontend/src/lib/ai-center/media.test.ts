import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AI_AGENTS } from './agents';
import { agentMedia } from './media';

const PUBLIC_DIR = resolve(__dirname, '../../../public');
const onDisk = (url: string) => existsSync(resolve(PUBLIC_DIR, `.${url}`));

describe('agentMedia', () => {
  it('points every catalog agent at files that exist under /public', () => {
    for (const agent of AI_AGENTS) {
      const media = agentMedia(agent.id);
      expect(onDisk(media.still), `${agent.id} still ${media.still}`).toBe(true);
      if (media.loop) expect(onDisk(media.loop), `${agent.id} loop ${media.loop}`).toBe(true);
    }
  });

  it('gives every animal a still and a loop, and the Master Agent a still only', () => {
    for (const agent of AI_AGENTS) {
      const media = agentMedia(agent.id);
      if (agent.id === 'master') {
        expect(media).toEqual({ still: '/ai-center/agents/master.png', loop: null });
      } else {
        expect(media).toEqual({
          still: `/ai-center/agents/still/${agent.id}.jpg`,
          loop: `/ai-center/agents/loop/${agent.id}.webp`,
        });
      }
    }
  });

  it('falls back to a still that exists for an unknown id', () => {
    const media = agentMedia('not-an-agent');
    expect(media.loop).toBeNull();
    expect(onDisk(media.still)).toBe(true);
  });
});
