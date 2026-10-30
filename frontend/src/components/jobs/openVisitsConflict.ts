/** One open visit (booked, on the way, on site or started), as the server's refusal lists it. */
export interface OpenVisitRow {
  id: string;
  visit_seq: number;
  status: string;
  scheduled_at: string | null;
  scheduled_end: string | null;
}

/** One job whose complete was refused, with the visits that are still open on it. */
export interface OpenVisitsJob {
  /** Empty for a single job (the refusal of POST /api/jobs/:id/complete does not repeat it). */
  id: string;
  /** Present for a bulk Completed, where the list has to say which job each visit is on. */
  job_number: string | null;
  open_visits: OpenVisitRow[];
}

/**
 * The jobs a complete was refused for because visits are still open (S04.17), or null when the error is anything
 * else. The two doors answer differently: a single job's refusal carries `open_visits`; a bulk Completed carries
 * `jobs`, every job in the batch that has any, and has completed none of them.
 */
export function openVisitsConflict(err: unknown): OpenVisitsJob[] | null {
  const res = (err as { response?: { status?: number; data?: { code?: string; open_visits?: unknown; jobs?: unknown } } })?.response;
  if (res?.status !== 409 || res.data?.code !== 'JOB_COMPLETE_HAS_OPEN_VISITS') return null;
  if (Array.isArray(res.data.jobs)) return res.data.jobs as OpenVisitsJob[];
  if (Array.isArray(res.data.open_visits)) {
    return [{ id: '', job_number: null, open_visits: res.data.open_visits as OpenVisitRow[] }];
  }
  return [];
}
