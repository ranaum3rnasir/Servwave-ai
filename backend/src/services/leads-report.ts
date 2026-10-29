// Leads report (catalog "leads") — pure aggregation, no Prisma/Express so it
// unit-tests with fixtures and shares the row shape with the frontend.
//
// Produces the same `LeadRow[]` shape the frontend report renders (see
// frontend/src/pages/reports/LeadsReport.tsx → interface Lead). The controller
// normalizes each Prisma lead into a LeadInput; this module maps the DB
// LeadStatus enum to the frontend's display statuses, derives the win/value
// signals from linked estimates, and sorts newest-first for a stable list.

import { ESTIMATE_STATUS } from '../constants/estimateStatus';

/** Frontend-facing lead status vocabulary (LeadsReport `STATUSES`). */
export type LeadDisplayStatus = 'Open' | 'Converted' | 'Sold' | 'Sold-done' | 'Lost';

/** Statuses that count as a win for the conversion KPIs (mirrors WON_STATUSES). */
export const WON_DISPLAY_STATUSES: LeadDisplayStatus[] = ['Converted', 'Sold', 'Sold-done'];

/**
 * Map the DB LeadStatus enum to the report's display status.
 *  • WON                                   → Sold-done (work sold + scheduled/closed)
 *  • ESTIMATED                             → Converted (estimate issued — converted to a quote)
 *  • LOST / CANCELLED                      → Lost
 *  • NEW / CONTACTED / WALKTHROUGH_SCHEDULED / WALKTHROUGH_COMPLETED → Open (still in the pipeline)
 * Kept here (not the controller) so demo + live share one mapping.
 */
export function displayStatusFor(status: string): LeadDisplayStatus {
  switch (status) {
    case 'WON':
      return 'Sold-done';
    case 'ESTIMATED':
      return 'Converted';
    case 'LOST':
    case 'CANCELLED':
      return 'Lost';
    // Still in the pipeline: a lead with a walkthrough booked or done is open work. Written out so
    // the intent is on the page; the default below would give the same answer.
    case 'NEW':
    case 'CONTACTED':
    case 'WALKTHROUGH_SCHEDULED':
    case 'WALKTHROUGH_COMPLETED':
      return 'Open';
    default:
      return 'Open';
  }
}

/** One linked estimate, normalized from the Prisma row by the controller. */
export interface LeadEstimateInput {
  /** Estimate total (already coerced from Decimal). */
  total: number;
  /** WON estimates carry the sold value + conversion date. */
  status: string;
  approvedAt: Date | null;
}

/** One lead + its context, normalized from the Prisma row by the controller. */
export interface LeadInput {
  leadNumber: string;
  client: string;
  email: string;
  phone: string;
  address: string;
  status: string; // raw LeadStatus enum value
  source: string | null;
  jobType: string | null;
  assigned: string;
  createdBy: string;
  tags: string[];
  createdAt: Date;
  scheduledAt: Date | null;
  estimates: LeadEstimateInput[];
}

/** The row shape the frontend renders (LeadsReport interface Lead). */
export interface LeadRow {
  leadNumber: number;
  client: string;
  email: string;
  phone: string;
  address: string;
  status: LeadDisplayStatus;
  source: string;
  assigned: string;
  createdBy: string;
  tags: string[];
  jobType: string;
  estimates: number;
  createdAt: string;
  scheduledAt: string | null;
  convertedAt: string | null;
  value: number;
}

/** "L00017680" / "L17680" / "17680" → 17680; non-numeric tail → 0. */
export function parseLeadNumber(leadNumber: string): number {
  const digits = leadNumber.replace(/\D/g, '');
  return digits ? Number(digits) : 0;
}

/**
 * Build the frontend lead rows from normalized inputs.
 * For each lead: map status, sum WON estimate totals into `value`, take the
 * latest WON estimate's approvedAt as `convertedAt`, and count estimates.
 * Won leads with no won-estimate signal still surface as won (status drives
 * the KPI), but value/convertedAt come only from real won estimates so the
 * numbers never fabricate revenue. Sorted by lead number descending (newest first).
 */
export function buildLeadsReport(leads: LeadInput[]): LeadRow[] {
  const rows = leads.map((l): LeadRow => {
    const approved = l.estimates.filter((e) => e.status === ESTIMATE_STATUS.WON);
    const value = approved.reduce((s, e) => s + e.total, 0);
    const convertedAt = approved
      .map((e) => e.approvedAt)
      .filter((d): d is Date => d != null)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      leadNumber: parseLeadNumber(l.leadNumber),
      client: l.client,
      email: l.email,
      phone: l.phone,
      address: l.address,
      status: displayStatusFor(l.status),
      source: l.source ?? '',
      assigned: l.assigned,
      createdBy: l.createdBy,
      tags: l.tags,
      jobType: l.jobType ?? '',
      estimates: l.estimates.length,
      createdAt: l.createdAt.toISOString(),
      scheduledAt: l.scheduledAt ? l.scheduledAt.toISOString() : null,
      convertedAt: convertedAt ? convertedAt.toISOString() : null,
      value,
    };
  });

  rows.sort((a, b) => b.leadNumber - a.leadNumber);
  return rows;
}
