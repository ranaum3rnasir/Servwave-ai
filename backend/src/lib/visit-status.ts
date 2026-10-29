import type { VisitStatus } from '@prisma/client';

/**
 * A visit that has not happened yet and has not been called off - the set multi-visit lets grow
 * past one per parent. Spelled ONCE because the needs-scheduling buckets, the current-visit
 * resolution, the D12 job-status derivation and the lead page all have to agree on what "still
 * coming" means.
 *
 * It sits in lib/ rather than in walkthrough.service.ts (which re-exports it, so every existing
 * importer is unaffected) purely so lib/job-status.ts can read it without the service and the
 * derivation importing each other. A second copy of the list is the one thing this constant
 * exists to prevent.
 */
export const LIVE_VISIT_STATUSES = ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] as const;

export function isLiveVisit(v: { status: VisitStatus }): boolean {
  return (LIVE_VISIT_STATUSES as readonly string[]).includes(v.status);
}
