/**
 * Lead stage-clock anchors — spec #1751 decision D8.
 *
 * D8's claim is that the alerting capability needs almost no new machinery: register the clocks
 * in the anchor registry and a business owner's policy ("every lead is contacted within four
 * hours") becomes an automation with direction 'after' and an offset, rather than code. These
 * tests hold that claim to account at the two places where it could quietly be false — the
 * candidate sweep, and the execution-time staleness floor.
 *
 * Written against the same seams the existing anchor tests use (dateAnchorSweep.test.ts,
 * terminalStale.test.ts), because a new anchor should be a new row in an established table, not a
 * new test strategy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { candidatesForAnchor } from '../dateAnchorSweep';
import { terminalStaleReason } from '../terminalStale';
import { ALL_ANCHOR_KEYS, ANCHORS_FOR_ENTITY, ANCHOR_LABELS, LEAD_STAGE_CLOCK_ANCHORS, anchorDateFor, type AnchorKey } from '../anchors';
import { dateAnchorTriggerConfigSchema, validateWorkflowDefinition } from '../workflowValidation';
import type { EntityState } from '../context';

const mockPrisma = prisma as any;
const ORG = 'org-1';
const now = new Date('2026-08-25T12:00:00.000Z');
const WINDOW = { gte: new Date('2026-08-24T12:00:00.000Z'), lte: now };

const STAGE_ANCHORS = [
  'lead.created_at',
  'lead.contacted_at',
  'lead.last_visit_completed_at',
] as const;

describe('the registry knows the three stage clocks', () => {
  it('offers them on the lead, and leaves every other entity alone', () => {
    for (const a of STAGE_ANCHORS) expect(ANCHORS_FOR_ENTITY.lead).toContain(a);
    // The alerting model is per-lead. Registering these on the job would let an owner build a
    // rule that can never fire, because anchorDateFor reads them off lead state only.
    expect(ANCHORS_FOR_ENTITY.job).not.toContain('lead.contacted_at' as AnchorKey);
    expect(ANCHORS_FOR_ENTITY.invoice).not.toContain('lead.contacted_at' as AnchorKey);
    expect(ANCHORS_FOR_ENTITY.estimate).not.toContain('lead.contacted_at' as AnchorKey);
  });

  it('keeps the walkthrough anchor exactly as it was', () => {
    // A standing risk recorded in the spec: the existing lead anchor resolves against the
    // CURRENT visit and is correct for the "one day before the walkthrough" reminder it powers.
    // New anchors are ADDED; that one must not be repointed at a monotonic clock underneath the
    // orgs already using it.
    expect(ANCHORS_FOR_ENTITY.lead[0]).toBe('lead.walkthrough_scheduled_at');
    expect(ANCHOR_LABELS['lead.walkthrough_scheduled_at']).toBe('the walkthrough');
    const state = { leadWalkthroughScheduledAt: now } as EntityState;
    expect(anchorDateFor('lead.walkthrough_scheduled_at', state)).toBe(now);
  });

  it('accepts each new anchor in a saved trigger config', () => {
    // The validator used to carry its OWN hand-written copy of the anchor set. A copy that fell
    // behind would reject an anchor the builder was already offering, and the owner would see an
    // unexplained error on save rather than a missing option.
    for (const anchor of STAGE_ANCHORS) {
      const parsed = dateAnchorTriggerConfigSchema.safeParse({ anchor, direction: 'after', offset_minutes: 240 });
      expect(parsed.success).toBe(true);
    }
    expect(dateAnchorTriggerConfigSchema.safeParse({ anchor: 'lead.invented', direction: 'after', offset_minutes: 1 }).success).toBe(false);
  });

  it('derives the validator set from the labels, so the two cannot drift', () => {
    expect([...ALL_ANCHOR_KEYS].sort()).toEqual(Object.keys(ANCHOR_LABELS).sort());
  });

  it('refuses a before-direction rule on a stage clock, in plain English', () => {
    // A stage clock records a moment AS IT HAPPENS, so "two hours before the lead arrives" can
    // never fire: the sweep's forward window will never contain a date already in the past. The
    // failure mode is pure silence — the rule saves, reads correctly in the builder, and nothing
    // ever happens — so it has to be refused at save time rather than left constructible.
    for (const anchor of STAGE_ANCHORS) {
      const issues = validateWorkflowDefinition({
        trigger_type: 'LEAD_DATE_ANCHORED',
        trigger_config: { anchor, direction: 'before', offset_minutes: 120 },
        steps: [],
      });
      const directionIssue = issues.find((i) => i.path === 'trigger_config.direction');
      expect(directionIssue).toBeDefined();
      expect(directionIssue!.message).toContain('after');
      // 'after' on the same anchor is the whole point of the feature and must stay legal.
      expect(
        validateWorkflowDefinition({
          trigger_type: 'LEAD_DATE_ANCHORED',
          trigger_config: { anchor, direction: 'after', offset_minutes: 120 },
          steps: [],
        }).some((i) => i.path === 'trigger_config.direction'),
      ).toBe(false);
    }
  });

  it('leaves before-direction rules alone on every anchor that is not a stage clock', () => {
    // The walkthrough anchor is an APPOINTMENT time, and "one day before the walkthrough" is the
    // reminder orgs already run on it.
    expect(
      validateWorkflowDefinition({
        trigger_type: 'LEAD_DATE_ANCHORED',
        trigger_config: { anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 },
        steps: [],
      }).some((i) => i.path === 'trigger_config.direction'),
    ).toBe(false);
    expect(
      validateWorkflowDefinition({
        trigger_type: 'INVOICE_DATE_ANCHORED',
        trigger_config: { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 },
        steps: [],
      }).some((i) => i.path === 'trigger_config.direction'),
    ).toBe(false);
  });

  it('names exactly the three stage clocks, derived rather than re-listed', () => {
    expect([...LEAD_STAGE_CLOCK_ANCHORS].sort()).toEqual([...STAGE_ANCHORS].sort());
  });

  it('reads each clock off lead state', () => {
    const state = {
      leadCreatedAt: new Date('2026-08-01T00:00:00.000Z'),
      leadContactedAt: new Date('2026-08-02T00:00:00.000Z'),
      leadLastVisitCompletedAt: new Date('2026-08-03T00:00:00.000Z'),
    } as EntityState;
    expect(anchorDateFor('lead.created_at', state)).toBe(state.leadCreatedAt);
    expect(anchorDateFor('lead.contacted_at', state)).toBe(state.leadContactedAt);
    expect(anchorDateFor('lead.last_visit_completed_at', state)).toBe(state.leadLastVisitCompletedAt);
    for (const a of STAGE_ANCHORS) expect(anchorDateFor(a, {} as EntityState)).toBeNull();
  });
});

describe('candidatesForAnchor — the stage clocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(STAGE_ANCHORS)('selects leads on %s and keys the occurrence to that clock', async (anchor) => {
    const column = anchor.slice('lead.'.length);
    const at = new Date('2026-08-24T18:00:00.000Z');
    mockPrisma.lead.findMany.mockResolvedValue([
      { id: 'lead-1', lead_number: 'L00001', created_at: null, contacted_at: null, last_visit_completed_at: null, [column]: at },
    ]);

    const out = await candidatesForAnchor(anchor, ORG, WINDOW);

    expect(mockPrisma.lead.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organization_id: ORG, [column]: WINDOW } }),
    );
    expect(out).toEqual([
      { entityType: 'lead', entityId: 'lead-1', entityLabel: 'L00001', occurrence: at.toISOString() },
    ]);
  });

  it('produces nothing for a lead whose clock has never been set', async () => {
    // The realistic majority on day one: contact time is largely unrecoverable, so most leads
    // carry null. Null must mean "no candidate", never "candidate at the epoch".
    mockPrisma.lead.findMany.mockResolvedValue([
      { id: 'lead-1', lead_number: 'L00001', created_at: null, contacted_at: null, last_visit_completed_at: null },
    ]);
    expect(await candidatesForAnchor('lead.contacted_at', ORG, WINDOW)).toEqual([]);
  });

  it('reads the LEAD table, not the visit table', async () => {
    // The two older lead-side anchors sweep `visits`. These are per-lead stored moments, so a
    // lead with three visits must still yield exactly one candidate.
    mockPrisma.lead.findMany.mockResolvedValue([]);
    await candidatesForAnchor('lead.last_visit_completed_at', ORG, WINDOW);
    expect(mockPrisma.visit.findMany).not.toHaveBeenCalled();
  });
});

describe('terminalStaleReason — LEAD_DATE_ANCHORED on a stage clock', () => {
  const base = { leadStatus: 'CONTACTED' } as EntityState;
  const stale = (state: EntityState, anchor: AnchorKey, direction: 'before' | 'after' = 'after') =>
    terminalStaleReason('LEAD_DATE_ANCHORED', undefined, state, now, direction, anchor);

  it('fires for a lead that has no visit booked at all', () => {
    // THE regression this guard's ordering exists to prevent. The walkthrough rules underneath
    // open with "if there is no scheduled walkthrough, this is stale" — which would silently
    // kill every "nobody contacted this lead" alert, because a lead nobody contacted is
    // precisely a lead with nothing booked.
    expect(stale({ ...base, leadWalkthroughScheduledAt: null }, 'lead.created_at')).toBeNull();
    expect(stale({ ...base, leadWalkthroughScheduledAt: null }, 'lead.contacted_at')).toBeNull();
  });

  it.each([
    ['lead.created_at', 'leadContactedAt', 'Lead has since been contacted'],
    ['lead.contacted_at', 'leadWalkthroughFirstBookedAt', 'Walkthrough has since been booked'],
    ['lead.last_visit_completed_at', 'leadFirstEstimateSentAt', 'Estimate has since been sent'],
  ] as const)('goes stale on %s once %s is set', (anchor, satisfiedBy, reason) => {
    // "…and it still has not happened", which the sweep cannot express because it selects purely
    // on the anchor date. Alerting is about failure, not volume: an owner asking to hear about a
    // lead nobody contacted within four hours does not want to hear about one contacted in three.
    expect(stale({ ...base, [satisfiedBy]: now } as EntityState, anchor)).toBe(reason);
    expect(stale(base, anchor)).toBeNull();
  });

  it.each(['LOST', 'CANCELLED', 'WON'] as const)('goes quiet on a %s lead', (leadStatus) => {
    for (const anchor of STAGE_ANCHORS) {
      expect(stale({ ...base, leadStatus }, anchor)).not.toBeNull();
    }
  });

  it('does not apply the "already happened" test to a before-direction rule', () => {
    // A 'before' reminder on a stage clock counts down to a moment already recorded, so there is
    // nothing outstanding for it to go stale against. Applying the check to both directions is
    // the mistake the older lead anchor's own comment warns about.
    expect(stale({ ...base, leadContactedAt: now }, 'lead.created_at', 'before')).toBeNull();
  });

  // OCCURRENCE MISMATCH, for the two stage clocks that can move.
  it('stops a run keyed on a contact time that has since been corrected', () => {
    // The correction door (POST /leads/:id/contact) is the spec's single deliberate exception to
    // first-touch-wins. An enrollment keyed on the OLD instant is counting a deadline the business
    // no longer believes in; the corrected date mints a new occurrence and the sweep re-enrols.
    const original = new Date('2026-08-24T09:00:00.000Z');
    const corrected = new Date('2026-08-23T16:30:00.000Z');
    const state = { ...base, leadContactedAt: corrected } as EntityState;
    expect(terminalStaleReason('LEAD_DATE_ANCHORED', original.toISOString(), state, now, 'after', 'lead.contacted_at'))
      .toBe('First contact was corrected — this run was replaced by an updated one');
    // Unchanged clock, same enrollment: still live.
    expect(terminalStaleReason('LEAD_DATE_ANCHORED', corrected.toISOString(), state, now, 'after', 'lead.contacted_at'))
      .toBeNull();
  });

  it('stops a run keyed on the first trip once a later trip has been completed', () => {
    // THE decision that makes multi-visit leads measurable, and the reason the estimate clock is
    // anchored on the LATEST completion rather than the first. A salesperson who finishes trip 1,
    // books trip 2 and correctly withholds the estimate must not be alerted as late against
    // trip 1: trip 2 completing re-anchors the clock, which mints a new occurrence, and the run
    // still pending on the old one steps aside for it.
    //
    // Note what is NOT tested here, because it deliberately does not happen: BOOKING trip 2 moves
    // no clock at all. Only a completion does, so a trip that is scheduled and then cancelled
    // leaves the first trip's deadline standing — a lead can never be kept out of the alert by
    // booking something it never does.
    const firstTrip = new Date('2026-08-20T15:00:00.000Z');
    const secondTrip = new Date('2026-08-24T11:00:00.000Z');
    const state = { ...base, leadLastVisitCompletedAt: secondTrip } as EntityState;
    expect(terminalStaleReason('LEAD_DATE_ANCHORED', firstTrip.toISOString(), state, now, 'after', 'lead.last_visit_completed_at'))
      .toBe('A later visit was completed — this run was replaced by one counting from it');
    // The run keyed on the latest trip is the live one, and it keeps counting.
    expect(terminalStaleReason('LEAD_DATE_ANCHORED', secondTrip.toISOString(), state, now, 'after', 'lead.last_visit_completed_at'))
      .toBeNull();
  });

  it('exempts the one clock that cannot move from the occurrence check', () => {
    // Not an oversight: `lead.created_at` is written once, by the database, so it can never
    // produce a second occurrence. A mismatch there would mean a corrupt enrollment key rather
    // than a moved clock — and killing the run over it would silently drop a real alert.
    const stateCreated = { ...base, leadCreatedAt: new Date('2026-08-20T00:00:00.000Z') } as EntityState;
    expect(terminalStaleReason('LEAD_DATE_ANCHORED', 'not-the-same-instant', stateCreated, now, 'after', 'lead.created_at'))
      .toBeNull();
  });

  it('falls back to the walkthrough rules when no anchor is supplied', () => {
    // Back-compat floor. An enrollment created before this spec, or one whose trigger_config is
    // malformed, must keep behaving exactly as it did — and the walkthrough anchor was the only
    // lead anchor those enrollments could have been built on.
    expect(terminalStaleReason('LEAD_DATE_ANCHORED', undefined, { ...base, leadWalkthroughScheduledAt: null }, now, 'after'))
      .toBe('Walkthrough is no longer scheduled');
    expect(terminalStaleReason('LEAD_DATE_ANCHORED', undefined, { ...base, leadWalkthroughScheduledAt: null }, now, 'after', 'lead.walkthrough_scheduled_at'))
      .toBe('Walkthrough is no longer scheduled');
  });
});
