/**
 * The attach picker's data source, shared by the hub call drawer and the
 * entity-tab comm rows so both offer the same targets.
 *
 * ALWAYS searchable. The picker used to have two modes - search only when the
 * row had no customer, otherwise a bare list of that customer's jobs and leads -
 * which meant the common case (a call the phone match resolved) had no way to
 * reach anything else, and a mis-attributed call could not be corrected at all.
 * There is no phone matching behind a job or a lead, so the customer has no
 * claim on which anchor is reachable; the server dropped its matching
 * same-customer guard for the same reason (see reassignCallJob).
 *
 * A customer, when there is one, now only supplies the DEFAULT list - their own
 * open jobs and leads, shown before anything is typed, since that is nearly
 * always what you want. Typing searches the whole org and replaces it.
 *
 * Both search endpoints are row-scoped server-side and the attach re-checks that
 * scope, so searching can never surface or attach a target the caller could not
 * otherwise reach.
 */
import { useState } from 'react';
import {
  useCustomerJobs,
  useCustomerLeads,
  useJobSearch,
  useLeadSearch,
  ATTACH_SEARCH_MIN,
  type CustomerJobNav,
  type CustomerLeadNav,
} from '@/lib/api/communication';

export type AttachTargets = {
  jobs: CustomerJobNav[];
  leads: CustomerLeadNav[];
  search: string;
  setSearch: (v: string) => void;
  /** Enough typed that the lists are search hits rather than the default list. */
  querying: boolean;
  /**
   * Too few characters typed AND no default list to fall back on - prompt for
   * input rather than claiming there are no results.
   */
  needsMoreInput: boolean;
  loading: boolean;
};

export function useAttachTargets(customerId?: string): AttachTargets {
  const [search, setSearch] = useState('');
  const querying = search.trim().length >= ATTACH_SEARCH_MIN;

  const customerJobs = useCustomerJobs(customerId);
  const customerLeads = useCustomerLeads(customerId);
  // Disabled until the term is long enough, so an untouched menu costs nothing.
  const jobHits = useJobSearch(search);
  const leadHits = useLeadSearch(search);

  // Typing always wins: the default list is a convenience, not a constraint.
  const source = querying
    ? { jobs: jobHits.data ?? [], leads: leadHits.data ?? [] }
    : { jobs: customerJobs.data ?? [], leads: customerLeads.data ?? [] };

  return {
    // A cancelled job / dead lead is never a useful attach target — same rule
    // both ways, applied here so neither call site has to remember it.
    jobs: source.jobs.filter((j) => j.open),
    leads: source.leads.filter((l) => l.open),
    search,
    setSearch,
    querying,
    needsMoreInput: !querying && !customerId,
    loading: querying
      ? jobHits.isFetching || leadHits.isFetching
      : customerJobs.isFetching || customerLeads.isFetching,
  };
}
