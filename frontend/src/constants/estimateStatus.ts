/**
 * Estimate v13 status rename — frontend mirror of `backend/src/constants/estimateStatus.ts`.
 * Frontend can't import backend code, so this is a manually-kept-in-sync duplicate, not a
 * re-export; if the backend file changes, update this one too.
 *
 * `EstimateStatus` (Prisma enum) is DRAFT/SENT/PENDING/WON/DECLINED/EXPIRED/ARCHIVED/SUPERSEDED —
 * eight values total, but the six below are the ones the product model exposes; EXPIRED and
 * SUPERSEDED stay legacy-only values with no UI (D1, closure-plan §10 / port-plan §4 M1 + §13).
 *
 * `WON` collides in meaning with `LeadStatus.WON` (and `ARCHIVED`/`CANCELLED`-adjacent strings are
 * shared across Job/Lead/ServicePlan/PlanVisit enums elsewhere in this codebase — port-plan §2.4,
 * §13). Always reference estimate statuses through this typed constant, never a bare string
 * literal, so a grep can still disambiguate which entity a `'WON'`/`'ARCHIVED'` site belongs to.
 */
export const ESTIMATE_STATUS = {
  DRAFT: 'DRAFT',
  SENT: 'SENT',
  PENDING: 'PENDING',
  WON: 'WON',
  DECLINED: 'DECLINED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type EstimateStatusValue = (typeof ESTIMATE_STATUS)[keyof typeof ESTIMATE_STATUS];
