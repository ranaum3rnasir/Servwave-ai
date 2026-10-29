// Where each AI Farm agent's portrait lives. One place, keyed by the agent id from `agents.ts`.
//
// Every animal has two files under /public/ai-center/agents/:
//   - still/<id>.jpg  a 272 px poster (about 10-20 KB), shown first and wherever the art stays still
//   - loop/<id>.webp  the animal's ordinary idle loop (animated WebP, about 100-300 KB), played only
//                     while the portrait is on screen and never under reduced motion
// The Master Agent has no animation set yet (redesign D10), so it has a still portrait only.
//
// The paths are a contract other surfaces build on (the catalog card, the detail modal, the booking
// modal, the job page tiles): keep them stable. Neither folder is in the service worker's precache
// (vite.config.ts `globPatterns` has no jpg or webp), so the loops never bloat offline storage.

export const AGENT_MEDIA_BASE = '/ai-center/agents';

/** The agents that ship an idle loop + still pair. Every catalog agent except the Master Agent. */
const ANIMATED_AGENT_IDS: ReadonlySet<string> = new Set([
  'maya', 'sarah', 'david', 'jordan', 'emily', 'tyler', 'olivia', 'daniel', 'iris', 'audrey',
  'ruby', 'chloe', 'nathan', 'phoenix', 'mike', 'hannah', 'carlos', 'leo', 'ben', 'lucas',
  'ethan', 'marcus', 'joseph', 'rachel', 'adam', 'naomi', 'jacob', 'goose', 'spider',
]);

export interface AgentMedia {
  /** Poster image: always present. Shown first, under reduced motion, and on still-only surfaces. */
  still: string;
  /** Animated idle loop, or null when the agent has no animation (the Master Agent). */
  loop: string | null;
}

/** The portrait files for one agent id. Unknown ids get the Master Agent's still, never a 404. */
export function agentMedia(id: string): AgentMedia {
  if (ANIMATED_AGENT_IDS.has(id)) {
    return {
      still: `${AGENT_MEDIA_BASE}/still/${id}.jpg`,
      loop: `${AGENT_MEDIA_BASE}/loop/${id}.webp`,
    };
  }
  return { still: `${AGENT_MEDIA_BASE}/master.png`, loop: null };
}
