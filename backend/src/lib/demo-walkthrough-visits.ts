/**
 * Which walkthrough visits a demo-org lead carries, given its status.
 *
 * A lead's status and its visits must tell the same story, or the demo contradicts the product:
 *   - Walkthrough Scheduled: a walkthrough is booked and has not happened, so one OPEN visit.
 *   - Walkthrough Completed: the walkthrough is done and nothing else is booked, so finished
 *     visits only.
 *   - Every other status carries no walkthrough visit in the demo data.
 *
 * Pure, so the seeder's choice is testable without a database (seed-demo-org.ts is a script).
 */
export interface DemoVisit {
  status: 'SCHEDULED' | 'COMPLETED';
  scheduled_at: Date;
  completed_at: Date | null;
}

export function demoVisitsForLeadStatus(
  leadStatus: string,
  instants: { scheduledAt: Date; completedAt: Date },
): DemoVisit[] {
  if (leadStatus === 'WALKTHROUGH_SCHEDULED') {
    return [{ status: 'SCHEDULED', scheduled_at: instants.scheduledAt, completed_at: null }];
  }
  if (leadStatus === 'WALKTHROUGH_COMPLETED') {
    // The visit started an hour before it was finished.
    return [
      {
        status: 'COMPLETED',
        scheduled_at: new Date(instants.completedAt.getTime() - 60 * 60 * 1000),
        completed_at: instants.completedAt,
      },
    ];
  }
  return [];
}
