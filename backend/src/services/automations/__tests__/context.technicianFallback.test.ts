import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { loadExecutionBundle, visitMergeFields } from '../context';

const mockPrisma = prisma as any;

/**
 * The crew fields resolve EMPTY when there is no crew.
 *
 * Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
 * (Implementation Decisions > Merge-field fallbacks). The words a customer reads when a merge
 * field has no value are the template author's, set per send step under "If empty, fill with",
 * never the context builder's. This file used to pin the opposite ('Our team' injected here);
 * it now pins that the builders inject nothing, and the seeded per-step defaults
 * (mergeFieldFallbacks.ts) are what keep an untouched template rendering as before.
 */

describe('visitMergeFields - crewless visit', () => {
  const VISIT = { scheduled_at: new Date('2026-08-01T15:00:00.000Z') };
  const TZ = 'America/New_York';
  /**
   * Where this trip is, already formatted by the caller (visit-location spec, slice 4). A
   * REQUIRED fourth argument, so a dispatch site cannot quietly leave the per-visit occurrence
   * rendering the job's next-upcoming-visit location instead of this trip's.
   */
  const WHERE = 'North Yard, 9 Depot Rd, Raleigh, NC';
  /**
   * The organisation's main line - a REQUIRED fifth argument for the same reason (slice 5): it is
   * what {{technician.phones}} falls back to, and a defaulted '' would render "Questions? Call ."
   * What this file asserts is still the crew NAMES; the phone half is performer-phone.test.ts's.
   */
  const MAIN_LINE = '(555) 204-7788';
  /**
   * The organisation's own number for this trip - a REQUIRED sixth argument (slice 7), for the
   * same reason again: {{technician.servwave_phones}} is the alternative field an author picks
   * when they will not publish mobiles, and a defaulted '' would put a hole in their email.
   * Resolved by the dispatch site, because it takes a database read this function cannot make.
   */
  const SERVWAVE = '(555) 204-0701';

  it("resolves 'technician.names' to '' for an empty crew (no words the author did not write)", () => {
    const fields = visitMergeFields(VISIT, [], TZ, WHERE, MAIN_LINE, SERVWAVE);
    expect(fields['technician.names']).toBe('');
  });

  it("resolves 'technician.first_name' to '' for an empty crew", () => {
    const fields = visitMergeFields(VISIT, [], TZ, WHERE, MAIN_LINE, SERVWAVE);
    expect(fields['technician.first_name']).toBe('');
  });

  it("resolves 'technician.names' to the joined crew names, unchanged, when a crew exists", () => {
    const fields = visitMergeFields(
      VISIT,
      [
        { first_name: 'Mike', last_name: 'Torres', phone: null, phone_ext: null },
        { first_name: 'Dre', last_name: 'Patel', phone: null, phone_ext: null },
      ],
      TZ,
      WHERE,
      MAIN_LINE,
      SERVWAVE,
    );
    expect(fields['technician.names']).toBe('Mike Torres, Dre Patel');
  });

  // Visit-location slice 4. The date already overrides per visit (D18); the location has to
  // travel the same channel or an occurrence enrolled by visit 3 renders visit 3's date beside
  // the job-level resolution's address - which, for a job whose trips are in different places, is
  // a customer sent somewhere they were not asked to go.
  it("carries the trip's own location through as 'job.visit_location'", () => {
    const fields = visitMergeFields(VISIT, [], TZ, WHERE, MAIN_LINE, SERVWAVE);
    expect(fields['job.visit_location']).toBe(WHERE);
    // ...and it travels BESIDE the date it has to agree with, in the one override object.
    expect(fields['job.scheduled_date']).toBeTruthy();
  });
});

describe('loadExecutionBundle - crewless job and walkthrough', () => {
  const ORG = '00000000-0000-0000-0000-000000000001';
  const JOB_ID = 'b0000000-0000-0000-0000-000000000002';
  const LEAD_ID = 'd0000000-0000-0000-0000-000000000002';

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.organization.findUnique.mockResolvedValue({
      name: 'Blue Ridge Plumbing',
      phone: '(555) 204-7788',
      timezone: 'America/New_York',
      currency: 'USD',
      logo_url: null,
      brand_color: '#0C2D3A',
    });
  });

  it("resolves both technician fields to '' when the job's trips carry no assignees", async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce({
      id: JOB_ID,
      job_number: 'J00099',
      status: 'SCHEDULED',
      scheduled_start: new Date('2026-08-01T15:00:00.000Z'),
      job_type: 'Repair',
      scope_notes: null,
      customer: { id: 'c1', first_name: 'Sarah', last_name: 'Mitchell', email: 's@example.com', phone: null },
      service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
      visits: [{ assignees: [] }],
      dispatcher: null,
      salesperson: null,
      estimate: null,
    });

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-crewless',
    });

    expect(result!.bundle.mergeCtx['technician.names']).toBe('');
    expect(result!.bundle.mergeCtx['technician.first_name']).toBe('');
  });

  it("resolves 'lead.performer_names' to '' for a walkthrough nobody is booked on", async () => {
    mockPrisma.lead.findFirst.mockResolvedValueOnce({
      id: LEAD_ID,
      lead_number: 'L00077',
      status: 'NEW',
      customer: { id: 'c1', first_name: 'Sarah', last_name: 'Mitchell', email: 's@example.com', phone: null },
      service_location: { address_line1: '123 Main St', city: 'Raleigh', state: 'NC' },
      commission_owner: null,
      visits: [{ scheduled_at: new Date('2026-08-01T15:00:00.000Z'), status: 'SCHEDULED', assignees: [] }],
    });

    const result = await loadExecutionBundle({
      entityType: 'lead',
      entityId: LEAD_ID,
      organizationId: ORG,
      dedupeKey: 'k-nobody',
    });

    expect(result!.bundle.mergeCtx['lead.performer_names']).toBe('');
  });

  it("resolves 'customer.first_name' to '' for a customer with no name at all", async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce({
      id: JOB_ID,
      job_number: 'J00099',
      status: 'SCHEDULED',
      scheduled_start: null,
      job_type: 'Repair',
      scope_notes: null,
      customer: { id: 'c1', customer_number: 'C00019', first_name: null, last_name: null, company_name: null, email: null, phone: null },
      service_location: null,
      visits: [],
      dispatcher: null,
      salesperson: null,
      estimate: null,
    });

    const result = await loadExecutionBundle({
      entityType: 'job',
      entityId: JOB_ID,
      organizationId: ORG,
      dedupeKey: 'k-nameless',
    });

    expect(result!.bundle.mergeCtx['customer.first_name']).toBe('');
  });
});
