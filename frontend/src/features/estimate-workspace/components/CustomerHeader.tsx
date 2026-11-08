import { Link } from 'react-router-dom';
import { Briefcase, MapPin, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StatusBadge } from '@/components/data/status-badge';
import type { StatusDomain } from '@/design-system/status-registry';
import type { PanelEstimate } from '../lib/panelEstimate';

interface AttachedRecord {
  domain: Extract<StatusDomain, 'lead' | 'job'>;
  id: string;
  label: string;
  href: string;
  status?: string | null;
  /** Spelled out on hover - the two job pointers are different relations, not duplicates. */
  relation: string;
  Icon: typeof User;
}

/**
 * Every record this estimate hangs off, in ONE place. Before this, a lead-anchored estimate got a
 * "View Lead ->" link here and a job-anchored one got nothing but an unlabelled `Actions > View
 * job` item, so where you looked depended on which anchor the estimate happened to have.
 *
 * Both job relations are represented and they are NOT interchangeable: `job_link` is the anchor
 * (Estimate.job_id - written against an existing job), `job` is provenance (Job.estimate_id - a
 * job created from this estimate). Deduped by job id in case a row ever carries both.
 */
function attachedRecords(estimate: PanelEstimate): AttachedRecord[] {
  const out: AttachedRecord[] = [];

  if (estimate.lead_id) {
    out.push({
      domain: 'lead',
      id: estimate.lead_id,
      label: `Lead ${estimate.lead?.lead_number ?? ''}`.trim(),
      href: `/leads/${estimate.lead_id}`,
      status: estimate.lead?.status,
      relation: 'This estimate was written for this lead',
      Icon: User,
    });
  }

  const jobs: { job: NonNullable<PanelEstimate['job_link']>; relation: string }[] = [];
  if (estimate.job_link) {
    jobs.push({ job: estimate.job_link, relation: 'This estimate is attached to this job' });
  }
  if (estimate.job && estimate.job.id !== estimate.job_link?.id) {
    jobs.push({ job: estimate.job, relation: 'Created from this estimate' });
  }
  // Degrade to an unnamed link rather than dropping the attachment, if a caller ever hands this
  // header an estimate shape that carries the scalar `job_id` without the relation beside it.
  // Losing the chip entirely would be the very bug this strip exists to fix.
  if (estimate.job_id && !jobs.some((j) => j.job.id === estimate.job_id)) {
    jobs.push({
      job: { id: estimate.job_id, job_number: '' },
      relation: 'This estimate is attached to this job',
    });
  }
  for (const { job, relation } of jobs) {
    out.push({
      domain: 'job',
      id: job.id,
      label: `Job ${job.job_number}`.trim(),
      href: `/jobs/${job.id}`,
      status: job.status,
      relation,
      Icon: Briefcase,
    });
  }

  return out;
}

/** "Sent 3 days ago" — relative-time recency line (§E-4). */
function relativeDays(iso?: string | null): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * Two-column document header (Workiz-style):
 *  - "Prepared For"   → customer + billing address (where the invoice goes)
 *  - "Service Location" → this estimate's job site (can differ; a customer may have many)
 *
 * §E-4 — status lives ONLY in the top-bar pill; this header shows a recency line instead
 * of a second status control.
 */
export function CustomerHeader({ estimate }: { estimate: PanelEstimate }) {
  // Fall back to the estimate's direct `customer` when there is no `lead` (a customer-anchored,
  // lead-less estimate). A header with no customer at all still renders nothing.
  const cust = estimate.lead?.customer ?? estimate.customer;
  if (!cust) return null;

  const name = cust.company_name || `${cust.first_name} ${cust.last_name}`;
  const attachments = attachedRecords(estimate);
  const cityLine = (city?: string | null, state?: string | null, zip?: string | null) =>
    [[city, state].filter(Boolean).join(', '), zip].filter(Boolean).join(' ');

  const billing = {
    line1: cust.billing_address_line1,
    line2: cust.billing_address_line2,
    cityState: cityLine(cust.billing_city, cust.billing_state, cust.billing_zip),
  };
  // The job site: the lead's own service_* scalars first, then the denormalized `service_location`
  // the backend returns on EVERY estimate (estimateDetailSelect selects it unconditionally, and
  // create() copies the lead's service_location_id onto the row). Branching on the presence of the
  // LEAD rather than of an ADDRESS used to drop the column whenever a lead carried a linked
  // ServiceLocation but null address scalars - both are independently settable on Lead, and the
  // scalars are the deprecated half.
  const loc = estimate.service_location;
  const hasAddress = (a: { line1?: string | null; line2?: string | null; cityState?: string | null }) =>
    Boolean(a.line1 || a.line2 || a.cityState);
  const leadService = estimate.lead
    ? {
        line1: estimate.lead.service_address_line1,
        line2: estimate.lead.service_address_line2,
        cityState: cityLine(
          estimate.lead.service_city,
          estimate.lead.service_state,
          estimate.lead.service_zip,
        ),
      }
    : null;
  // Whole-address precedence, never field-by-field: a street from one source under a city from the
  // other would render an address that exists nowhere.
  const service =
    leadService && hasAddress(leadService)
      ? leadService
      : {
          line1: loc?.address_line1,
          line2: loc?.address_line2,
          cityState: cityLine(loc?.city, loc?.state, loc?.zip),
        };
  // Neither source produced an address; drop the Service Location column (and the two-column
  // split) rather than leaving an awkward empty half. `line2` counts - an address that is nothing
  // but an `address_line2` still has one line worth showing.
  const hasService = hasAddress(service);

  const Column = ({
    label,
    line1,
    line2,
    cityState,
    accent,
  }: {
    label: string;
    line1?: string | null;
    line2?: string | null;
    cityState?: string | null;
    accent?: boolean;
  }) => (
    <div className="min-w-0">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-text-secondary">
        {accent && <MapPin className="h-3.5 w-3.5 text-primary" />}
        {label}
      </p>
      <p className="text-sm font-bold text-text-primary">{name}</p>
      <div className="mt-0.5 space-y-0.5 text-sm text-text-secondary">
        {line1 && <p>{line1}</p>}
        {line2 && <p>{line2}</p>}
        {cityState && <p>{cityState}</p>}
        {cust.phone && (
          <a href={`tel:${cust.phone}`} className="block text-primary hover:underline">
            {cust.phone}
          </a>
        )}
        {cust.email && (
          <a href={`mailto:${cust.email}`} className="block truncate text-primary hover:underline">
            {cust.email}
          </a>
        )}
      </div>
    </div>
  );

  return (
    <section className="rounded-card border border-border bg-surface-light p-5 shadow-card">
      <div className={cn('grid grid-cols-1 gap-6', hasService && 'sm:grid-cols-2')}>
        <Column
          label="Prepared For"
          line1={billing.line1}
          line2={billing.line2}
          cityState={billing.cityState}
        />
        {hasService && (
          <Column
            label="Service Location"
            line1={service.line1}
            line2={service.line2}
            cityState={service.cityState}
            accent
          />
        )}
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-1 text-xs font-bold uppercase tracking-wide text-text-secondary">
              Attached to
            </p>
            {attachments.length === 0 ? (
              <span className="text-sm text-text-soft">
                Nothing yet - this estimate stands on its own
              </span>
            ) : (
              attachments.map((a) => (
                <Link
                  key={`${a.domain}-${a.id}`}
                  to={a.href}
                  title={a.relation}
                  className="group inline-flex items-center gap-2 rounded-control border border-border bg-background-light px-2.5 py-1.5 transition-colors hover:border-primary hover:bg-primary-subtle"
                >
                  <a.Icon className="h-3.5 w-3.5 text-text-secondary group-hover:text-primary" />
                  <span className="text-sm font-bold text-text-primary">{a.label}</span>
                  {a.status && <StatusBadge domain={a.domain} status={a.status} />}
                </Link>
              ))
            )}
          </div>
          <span className="shrink-0 text-sm text-text-secondary">
            {relativeDays(estimate.sent_at) && `Sent ${relativeDays(estimate.sent_at)}`}
          </span>
        </div>
      </div>
    </section>
  );
}
