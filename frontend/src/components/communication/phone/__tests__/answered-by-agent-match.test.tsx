// Matching a call's answerer to an agent in the roster.
//
// `answeredBy.id` is the ServWave USER who answered (see the backend's
// mapAnsweredBy), while a PhoneAgent row has its own primary key and carries
// the user it is linked to as `userId`. Comparing the two directly - which is
// what every call site did - never matched on real data, so the Calls table
// showed no answerer name and the per-agent Performance drawer listed zero
// calls for everyone.
//
// The demo seed does key `answeredBy.id` to the agent's own id, so both
// identities have to keep working.
import { describe, it, expect } from 'vitest';
import { agentName, agentMatchesId } from '../useCallsPipeline';
import type { PhoneAgent } from '@/lib/api/communication';

const base = {
  kind: 'human' as const,
  role: 'CSR',
  calls: 0,
  answerRatePct: 0,
  bookingRatePct: 0,
  ahtSec: 0,
  sentimentPct: 0,
  revenue: 0,
  scriptAdherencePct: 0,
};

const LINKED: PhoneAgent = { ...base, id: 'agent-row-1', name: 'Dana Reyes', userId: 'user-aa' };
const UNLINKED: PhoneAgent = { ...base, id: 'agent-row-2', name: 'Front desk' };

describe('agentMatchesId', () => {
  it('matches the ServWave user id a real call carries', () => {
    expect(agentMatchesId(LINKED, 'user-aa')).toBe(true);
  });

  it('still matches the agent row id the demo seed uses', () => {
    expect(agentMatchesId(LINKED, 'agent-row-1')).toBe(true);
  });

  it('does not match a different person', () => {
    expect(agentMatchesId(LINKED, 'user-bb')).toBe(false);
  });

  it('an unlinked agent never matches an absent id', () => {
    // The trap: `agent.userId === call.answeredBy.id` is undefined === undefined
    // for an unlinked agent and an unattributed call, which would sweep every
    // unattributed call into that agent's drawer.
    expect(agentMatchesId(UNLINKED, undefined)).toBe(false);
    expect(agentMatchesId(LINKED, undefined)).toBe(false);
  });
});

describe('agentName', () => {
  it('names the answerer from the linked user id', () => {
    expect(agentName([LINKED, UNLINKED], 'user-aa')).toBe('Dana Reyes');
  });

  it('names the answerer from the agent row id', () => {
    expect(agentName([LINKED, UNLINKED], 'agent-row-2')).toBe('Front desk');
  });

  it('is undefined for an id nobody owns, and for no id at all', () => {
    expect(agentName([LINKED], 'user-zz')).toBeUndefined();
    expect(agentName([LINKED], undefined)).toBeUndefined();
  });
});
