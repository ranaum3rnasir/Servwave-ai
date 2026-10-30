/**
 * lead-contact-on-link.test.ts — SPEC-4 §6.1 / §7.3: the one rule every attach and move door uses
 * to decide whether linking an EXISTING communication to a lead counts as reaching out to it.
 *
 * The rule, in plain words: a human, outbound communication that actually went out, newly linked
 * to the lead, counts. It is dated at the communication's own time and credited to its own sender.
 *
 * SEAM: `contactFromLeadLink`, pure. Every door (text, call, email attach; the logged-entry move)
 * hands it the stored row before and after its write, so the whole rule is stated here once as a
 * table, and each door's own request test only has to show that it hands the rule the right row.
 * The expected values are literals from the spec, never recomputed from the inputs.
 */
import { describe, it, expect } from 'vitest';
import {
  contactFromLeadLink,
  leadLeftBehind,
  rowWouldRelease,
  type LeadEntryChange,
  type LeadLink,
} from '../services/lead-contact.service';

const ORG = 'org-1';
const LEAD_A = 'lead-a';
const LEAD_B = 'lead-b';
const AT = new Date('2026-10-20T14:05:00.000Z');
const ACTOR = 'user-7';

/** An outbound human text that was sent, newly attached to lead A. Each case changes one thing. */
function textLink(overrides: Partial<LeadLink> = {}): LeadLink {
  return {
    source: 'text', channel: 'text', orgId: ORG,
    leadIdBefore: null, leadIdAfter: LEAD_A,
    directionBefore: 'out', directionAfter: 'out',
    automated: false, deliveryStatus: 'sent',
    at: AT, actorId: ACTOR,
    ...overrides,
  };
}

const emailLink = (overrides: Partial<LeadLink> = {}) =>
  textLink({ source: 'email', channel: 'email', deliveryStatus: 'SENT', ...overrides });
const callLink = (overrides: Partial<LeadLink> = {}) =>
  textLink({ source: 'call', channel: 'call', deliveryStatus: undefined, ...overrides });
/** A logged entry stores its direction upper-case ('IN' | 'OUT'). */
const logLink = (overrides: Partial<LeadLink> = {}) =>
  textLink({ source: 'log', channel: 'call', directionBefore: 'OUT', directionAfter: 'OUT', deliveryStatus: undefined, ...overrides });

describe('contactFromLeadLink — a newly linked outbound communication that went out counts', () => {
  it('an attached sent text is a text contact on the new lead, at its own time and from its own sender', () => {
    expect(contactFromLeadLink(textLink())).toEqual({
      leadId: LEAD_A, orgId: ORG, channel: 'text', direction: 'out', automated: false, at: AT, actorId: ACTOR,
    });
  });

  it('passes the contact time and the sender through unchanged, including an unknown sender', () => {
    const longAgo = new Date('2025-01-02T03:04:05.006Z');
    expect(contactFromLeadLink(textLink({ at: longAgo, actorId: null }))).toMatchObject({ at: longAgo, actorId: null });
  });
});

describe('contactFromLeadLink — the logged-entry move table (SPEC-4 §6.5, D6)', () => {
  it.each<[string, Partial<LeadLink>, string | null]>([
    ['OUT on customer/job -> OUT on lead L', { leadIdBefore: null, leadIdAfter: LEAD_A }, LEAD_A],
    ['OUT on lead A -> OUT on lead B', { leadIdBefore: LEAD_A, leadIdAfter: LEAD_B }, LEAD_B],
    ['IN on lead A -> OUT on lead A', { leadIdBefore: LEAD_A, leadIdAfter: LEAD_A, directionBefore: 'IN' }, null],
    ['IN on customer -> OUT on lead L, one save', { leadIdBefore: null, leadIdAfter: LEAD_A, directionBefore: 'IN' }, null],
    ['OUT on lead A -> OUT on lead A, new time/notes', { leadIdBefore: LEAD_A, leadIdAfter: LEAD_A }, null],
    ['OUT on lead A -> OUT on job/customer', { leadIdBefore: LEAD_A, leadIdAfter: null }, null],
    ['OUT on lead A -> IN on lead A', { leadIdBefore: LEAD_A, leadIdAfter: LEAD_A, directionAfter: 'IN' }, null],
    ['OUT on lead A -> IN on lead B, one save', { leadIdBefore: LEAD_A, leadIdAfter: LEAD_B, directionAfter: 'IN' }, null],
  ])('%s', (_label, change, releases) => {
    const touch = contactFromLeadLink(logLink(change));
    expect(touch?.leadId ?? null).toBe(releases);
  });

  it('a released log move is dated at the entry and credited to its performer, in the canonical lower-case direction', () => {
    expect(contactFromLeadLink(logLink({ leadIdBefore: LEAD_A, leadIdAfter: LEAD_B }))).toEqual({
      leadId: LEAD_B, orgId: ORG, channel: 'call', direction: 'out', automated: false, at: AT, actorId: ACTOR,
    });
  });
});

describe('contactFromLeadLink — a text counts only once it went out', () => {
  it.each<[string | null, boolean]>([
    ['sent', true],
    ['delivered', true],
    ['skipped', false],
    ['failed', false],
    ['queued', false],
    ['received', false],
    [null, false],
  ])('status %s -> releases: %s', (status, releases) => {
    expect(contactFromLeadLink(textLink({ deliveryStatus: status })) !== null).toBe(releases);
  });
});

describe('contactFromLeadLink — an email counts only once it was sent or delivered', () => {
  it.each<[string | null, boolean]>([
    ['SENT', true],
    ['DELIVERED', true],
    ['BOUNCED', false],
    ['FAILED', false],
    ['QUEUED', false],
    [null, false],
  ])('delivery status %s -> releases: %s', (status, releases) => {
    expect(contactFromLeadLink(emailLink({ deliveryStatus: status })) !== null).toBe(releases);
  });
});

describe('contactFromLeadLink — a call has no went-out gate', () => {
  it.each<[string | null | undefined]>([[undefined], [null], ['completed'], ['no-answer'], ['failed']])(
    'an outbound call attached with status %s counts, dated at its start',
    (status) => {
      expect(contactFromLeadLink(callLink({ deliveryStatus: status }))).toEqual({
        leadId: LEAD_A, orgId: ORG, channel: 'call', direction: 'out', automated: false, at: AT, actorId: ACTOR,
      });
    },
  );
});

describe('contactFromLeadLink — direction', () => {
  it.each<[string | null, boolean]>([
    ['out', true],
    ['OUT', true],
    ['in', false],
    ['IN', false],
    [null, false],
  ])('direction %s on both sides -> releases: %s', (direction, releases) => {
    expect(contactFromLeadLink(callLink({ directionBefore: direction, directionAfter: direction })) !== null).toBe(releases);
  });
});

describe('contactFromLeadLink — provenance', () => {
  it.each<[boolean | null, boolean]>([
    [true, false],
    [false, true],
    // Historical rows carry null, which the columns' own default reads as human.
    [null, true],
  ])('automated %s -> releases: %s', (automated, releases) => {
    for (const link of [textLink({ automated }), emailLink({ automated })]) {
      expect(contactFromLeadLink(link) !== null).toBe(releases);
    }
  });
});

describe('contactFromLeadLink — only a NEW link counts', () => {
  it('re-attaching a text to the lead it is already on is no contact', () => {
    expect(contactFromLeadLink(textLink({ leadIdBefore: LEAD_A, leadIdAfter: LEAD_A }))).toBeNull();
  });

  it('detaching a text from its lead is no contact', () => {
    expect(contactFromLeadLink(textLink({ leadIdBefore: LEAD_A, leadIdAfter: null }))).toBeNull();
  });

  it('moving a sent text from one lead to another is a contact on the lead it reached', () => {
    expect(contactFromLeadLink(textLink({ leadIdBefore: LEAD_A, leadIdAfter: LEAD_B }))?.leadId).toBe(LEAD_B);
  });
});

// ─── D7 (SPEC-4 §6.12.1, §6.12.2): the same rule read the other way ─────────────────────────────
//
// A lead stays Contacted only while an entry that would have released it is still on it. Whether a
// stored row "would have released" is `rowWouldRelease`, the release rule read off one row; which
// lead a change left without such an entry is `leadLeftBehind`. Both are pure and stated here as
// tables of the spec's literals.

type Row = { direction: string | null; automated: boolean | null; deliveryStatus?: string | null };

describe('rowWouldRelease — does a stored row count as an outbound contact on its lead?', () => {
  it.each<[LeadLink['source'], Row, boolean]>([
    // Texts: human, outbound, and only once it went out.
    ['text', { direction: 'out', automated: false, deliveryStatus: 'sent' }, true],
    ['text', { direction: 'out', automated: false, deliveryStatus: 'delivered' }, true],
    ['text', { direction: 'out', automated: null, deliveryStatus: 'sent' }, true],
    ['text', { direction: 'OUT', automated: false, deliveryStatus: 'sent' }, true],
    ['text', { direction: 'out', automated: false, deliveryStatus: 'skipped' }, false],
    ['text', { direction: 'out', automated: false, deliveryStatus: 'failed' }, false],
    ['text', { direction: 'out', automated: false, deliveryStatus: 'queued' }, false],
    ['text', { direction: 'out', automated: false, deliveryStatus: null }, false],
    ['text', { direction: 'out', automated: true, deliveryStatus: 'sent' }, false],
    ['text', { direction: 'in', automated: false, deliveryStatus: 'received' }, false],
    ['text', { direction: null, automated: false, deliveryStatus: 'sent' }, false],
    // Emails: human, outbound, sent or delivered.
    ['email', { direction: 'out', automated: false, deliveryStatus: 'SENT' }, true],
    ['email', { direction: 'out', automated: null, deliveryStatus: 'DELIVERED' }, true],
    ['email', { direction: 'out', automated: false, deliveryStatus: 'QUEUED' }, false],
    ['email', { direction: 'out', automated: false, deliveryStatus: 'DEFERRED' }, false],
    ['email', { direction: 'out', automated: false, deliveryStatus: 'BOUNCED' }, false],
    ['email', { direction: 'out', automated: false, deliveryStatus: 'FAILED' }, false],
    ['email', { direction: 'out', automated: false, deliveryStatus: 'COMPLAINED' }, false],
    ['email', { direction: 'out', automated: false, deliveryStatus: null }, false],
    ['email', { direction: 'out', automated: true, deliveryStatus: 'SENT' }, false],
    ['email', { direction: 'in', automated: false, deliveryStatus: null }, false],
    // Calls: any outbound call, whatever its status.
    ['call', { direction: 'out', automated: false, deliveryStatus: 'no-answer' }, true],
    ['call', { direction: 'out', automated: null }, true],
    ['call', { direction: 'in', automated: false }, false],
    ['call', { direction: null, automated: false }, false],
    // Logged entries store 'OUT' / 'IN'.
    ['log', { direction: 'OUT', automated: false }, true],
    ['log', { direction: 'IN', automated: false }, false],
  ])('%s %o -> %s', (source, row, holds) => {
    expect(rowWouldRelease(source, row)).toBe(holds);
  });

  // The link check (§7.3): the release and the hold are one rule, so a link that releases a lead
  // always leaves a row that holds it.
  it('whenever contactFromLeadLink releases, the row it leaves on the lead would release', () => {
    const sources: LeadLink['source'][] = ['text', 'email', 'call', 'log'];
    const directions = ['out', 'OUT', 'in', 'IN', null];
    const automated = [true, false, null];
    const statuses = ['sent', 'delivered', 'skipped', 'failed', 'queued', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED', 'QUEUED', null, undefined];
    let released = 0;
    for (const source of sources) for (const direction of directions) for (const auto of automated) for (const status of statuses) {
      const link = textLink({
        source, directionBefore: direction, directionAfter: direction, automated: auto, deliveryStatus: status,
      });
      if (contactFromLeadLink(link) === null) continue;
      released += 1;
      expect(rowWouldRelease(source, { direction, automated: auto, deliveryStatus: status })).toBe(true);
    }
    // Not vacuous: plenty of the grid releases.
    expect(released).toBeGreaterThan(20);
  });
});

describe('leadLeftBehind — the lead an entry stopped holding (the D7 table)', () => {
  const OUT_LOG = { direction: 'OUT', automated: false };
  const change = (before: LeadEntryChange['before'], after: LeadEntryChange['after'], source: LeadLink['source'] = 'log'): LeadEntryChange =>
    ({ source, before, after });

  it.each<[string, LeadEntryChange, string | null]>([
    ['OUT on A -> OUT on B', change({ leadId: LEAD_A, ...OUT_LOG }, { leadId: LEAD_B, ...OUT_LOG }), LEAD_A],
    ['OUT on A -> OUT on the customer or a job', change({ leadId: LEAD_A, ...OUT_LOG }, { leadId: null, ...OUT_LOG }), LEAD_A],
    ['OUT on A -> deleted', change({ leadId: LEAD_A, ...OUT_LOG }, null), LEAD_A],
    ['OUT on A -> IN on A', change({ leadId: LEAD_A, ...OUT_LOG }, { leadId: LEAD_A, direction: 'IN', automated: false }), LEAD_A],
    ['OUT on A -> IN on B, one save', change({ leadId: LEAD_A, ...OUT_LOG }, { leadId: LEAD_B, direction: 'IN', automated: false }), LEAD_A],
    ['OUT on A -> OUT on A (new time, notes, channel or person)', change({ leadId: LEAD_A, ...OUT_LOG }, { leadId: LEAD_A, ...OUT_LOG }), null],
    ['IN on A -> anything', change({ leadId: LEAD_A, direction: 'IN', automated: false }, { leadId: LEAD_B, ...OUT_LOG }), null],
    ['IN on A -> deleted', change({ leadId: LEAD_A, direction: 'IN', automated: false }, null), null],
    ['nothing on a lead before -> anything', change({ leadId: null, ...OUT_LOG }, { leadId: LEAD_B, ...OUT_LOG }), null],
    ['nothing on a lead before -> deleted', change({ leadId: null, ...OUT_LOG }, null), null],
    ['a sent text detached from A', change({ leadId: LEAD_A, direction: 'out', automated: false, deliveryStatus: 'sent' }, { leadId: null, direction: 'out', automated: false, deliveryStatus: 'sent' }, 'text'), LEAD_A],
    ['an automated text detached from A', change({ leadId: LEAD_A, direction: 'out', automated: true, deliveryStatus: 'sent' }, { leadId: null, direction: 'out', automated: true, deliveryStatus: 'sent' }, 'text'), null],
    ['a skipped text detached from A', change({ leadId: LEAD_A, direction: 'out', automated: false, deliveryStatus: 'skipped' }, { leadId: null, direction: 'out', automated: false, deliveryStatus: 'skipped' }, 'text'), null],
    ['a bounced email moved from A to B', change({ leadId: LEAD_A, direction: 'out', automated: false, deliveryStatus: 'BOUNCED' }, { leadId: LEAD_B, direction: 'out', automated: false, deliveryStatus: 'BOUNCED' }, 'email'), null],
    ['an outbound call re-attached to A', change({ leadId: LEAD_A, direction: 'out', automated: false }, { leadId: LEAD_A, direction: 'out', automated: false }, 'call'), null],
    ['an outbound call filed on a job of another lead', change({ leadId: LEAD_A, direction: 'out', automated: false }, { leadId: LEAD_B, direction: 'out', automated: false }, 'call'), LEAD_A],
  ])('%s -> %s', (_label, c, reconsider) => {
    expect(leadLeftBehind(c)).toBe(reconsider);
  });
});
