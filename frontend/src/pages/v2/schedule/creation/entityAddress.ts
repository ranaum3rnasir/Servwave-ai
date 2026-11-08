/**
 * Where a creation-picker row's address comes from.
 *
 * THE RULE: a job's address is the job's OWN service location; a walkthrough's is the
 * LEAD's own service address. Never the customer's.
 *
 * A customer can have many service locations, so resolving through the customer record
 * answers a different question than the one the row is asking - "where is this job?" -
 * and will confidently print the wrong street for any customer with more than one site.
 * There is deliberately no customer fallback here: a missing address renders blank,
 * because blank is honest and a plausible wrong address is not.
 *
 * `job.customer` / `lead.customer` ARE in hand at both call sites (the rows show the
 * customer NAME), which is exactly why this is a named module rather than an inline
 * expression - the wrong implementation is the convenient one.
 */

/** A job's own service location, as `/api/jobs` selects it (job.controller.ts). */
interface ServiceLocationShape {
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
}

function joinParts(parts: (string | null | undefined)[]): string {
  return parts.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean).join(', ');
}

/**
 * The address of a JOB, read from its own `service_location` relation.
 * Returns '' when the job has no location - never the customer's.
 */
export function jobAddress(job: Record<string, unknown>): string {
  const loc = job.service_location as ServiceLocationShape | null | undefined;
  if (!loc) return '';
  return joinParts([loc.address_line1, loc.city, loc.state]);
}

/**
 * The address of a WALKTHROUGH, read from the lead's own flat service_* fields.
 * Returns '' when the lead has none - never the customer's.
 */
export function walkthroughAddress(lead: Record<string, unknown>): string {
  return joinParts([
    lead.service_address_line1 as string | undefined,
    lead.service_city as string | undefined,
    lead.service_state as string | undefined,
  ]);
}

/** The customer's display name for a row's first line. Name only - addresses never come from here. */
export function customerDisplayName(entity: Record<string, unknown>): string {
  const c = entity.customer as
    | { first_name?: string; last_name?: string; company_name?: string }
    | null
    | undefined;
  if (!c) return '';
  return (c.company_name || `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || '').trim();
}
