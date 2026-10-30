import { Map } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { useAppAbility } from '@/contexts/AbilityContext';
import { CustomerContactBlock } from '@/components/contact/CustomerContactBlock';
import { isIosDevice, mapsHref } from '@/components/contact/contactHrefs';
import { SectionCard, SectionLabel } from '@/components/jobs/overview/SectionCard';
import { ServiceLocationMap } from '@/components/crm/service-location-map';
import { Button } from '@/components/ui/button';
import { ChannelIcon, LoggedChip, channelLabel } from '@/components/communication/shared/atoms';
/**
 * The SHARED CommItem contract, imported rather than mirrored locally.
 *
 * This card used to declare its own copy of the type. That copy is what made the manual
 * communication log invisible here: the shared contract gained `manuallyLogged` in slice 1 and the
 * aggregator started returning hand-logged rows on THIS endpoint in slice 5, but a local mirror
 * cannot gain a field, so the card went on rendering a typed-up note exactly like a recorded call.
 * A duplicated contract does not fail when it falls behind — it just quietly stops telling the
 * truth, which is why the duplicate is deleted rather than extended.
 */
import { newestFirst, type CommItem } from '@/lib/api/jobCommunications';
import type { RecordContactEntry } from '@/lib/api/recordContactEntries';
import api from '@/lib/axios';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  /** The full contact set the job detail answers: every phone and every email on file. */
  phones?: { phone: string; label: string | null; extension: string | null; is_primary: boolean }[];
  emails?: { email: string; label: string | null; is_primary: boolean }[];
}

interface ServiceLocation {
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  zip: string;
}

interface CustomerContactCardProps {
  job: {
    id: string;
    job_number: string;
    customer: Customer;
    service_location: ServiceLocation | null;
    /** The job's own phones and emails, added with the pencil. */
    contact_entries?: RecordContactEntry[];
    /** The completed-job lock for this person, for the job as a whole. */
    locked?: boolean;
    /**
     * The lock for this person on the job's customer details: true takes the pencils off the block. The server answers it
     * apart from `locked` because the review's holder keeps these while the job is in Office review (S06.9).
     */
    contact_locked?: boolean;
  };
  onViewAllCommunications?: () => void;
}

// The stacked icon + label tile of the Map action. Left a plain element rather than a Button: the tile
// look is outside Button's reach. The customer's own Call, Text and Email actions are the contact block's.
const TILE_CLASS = cn(
  'flex flex-col items-center gap-1 rounded-lg border border-border bg-background-light/40 py-2 px-1',
  'text-[11px] font-medium text-text-secondary hover:text-primary hover:border-primary/40 transition-colors',
);

// ─── Component ─────────────────────────────────────────────────────────────────

export function CustomerContactCard({ job, onViewAllCommunications }: CustomerContactCardProps) {
  const { customer, service_location: loc } = job;
  const ability = useAppAbility();
  const canReadComms = ability.can('read', 'Communication');

  const name = customerDisplayName(customer);

  // The address (or, with no service location, the customer's name) the Map tile searches for;
  // mapsHref turns it into a link that opens the device's native maps app.
  const mapQuery = loc
    ? [loc.address_line1, loc.address_line2, loc.city, loc.state, loc.zip].filter(Boolean).join(', ')
    : customer.phone
      ? name
      : null;

  // Recent communications — only fetched when ability grants it
  const { data: recentComms } = useQuery({
    queryKey: ['job-communications-preview', job.id],
    queryFn: async () => {
      const { data } = await api.get(`/api/jobs/${job.id}/communications`);
      return (data.items ?? []) as CommItem[];
    },
    enabled: canReadComms,
  });

  // The aggregator returns items oldest-first; `newestFirst` (the one owner of the timeline's
  // display order, shared with the Job/Lead/Customer tabs) flips them, and this card shows the
  // three most-recent.
  const lastThreeComms = newestFirst(recentComms).slice(0, 3);


  return (
    <SectionCard title="Customer &amp; Contact" bodyClassName="space-y-4">
      {/* Name, company, every phone and email, and the address, drawn through the contact display policy. */}
      <CustomerContactBlock
        customer={customer}
        context={{ jobId: job.id, jobLabel: job.job_number }}
        serviceAddress={mapQuery && loc ? mapQuery : null}
        record={{ kind: 'job', id: job.id, locked: job.contact_locked ?? job.locked }}
        entries={job.contact_entries}
        showActions
        editCustomer
      />

      {/* The Map action stays a tile: it opens the device's maps app, not a customer contact. */}
      {mapQuery && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <a
            href={mapsHref(mapQuery, { ios: isIosDevice() })}
            target="_blank"
            rel="noopener noreferrer"
            className={TILE_CLASS}
          >
            <Map className="h-4 w-4" />
            Map
          </a>
        </div>
      )}

      {loc && (
        <ServiceLocationMap
          addressLine1={loc.address_line1}
          city={loc.city}
          state={loc.state}
          zip={loc.zip}
        />
      )}

      {/* Communication History — only when ability grants read:Communication */}
      {canReadComms && (
        <div>
          <SectionLabel
            action={
              onViewAllCommunications && (
                <Button
                  type="button"
                  variant="link"
                  size={null}
                  onClick={onViewAllCommunications}
                  className="shrink-0"
                >
                  View All
                </Button>
              )
            }
          >
            Communication History
          </SectionLabel>
          {lastThreeComms.length === 0 ? (
            <p className="text-xs text-text-secondary italic">No messages yet</p>
          ) : (
            <div className="space-y-2">
              {lastThreeComms.map((msg) => {
                const isPayment = msg.entry === 'payment_received';
                const label = channelLabel(msg.channel, isPayment);
                return (
                  <div key={msg.id} className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-xs text-text-secondary">
                      {isPayment ? (
                        // Money on an invoice, not something the customer said: worded from its title, never "{customer}: ...".
                        <>
                          <span className="font-medium text-text-primary">{msg.title}</span>
                          {': '}
                          {msg.preview.slice(0, 64)}
                        </>
                      ) : (
                        <>
                          <span
                            className={cn(
                              'font-medium',
                              msg.direction === 'in' ? 'text-primary' : 'text-text-primary',
                            )}
                          >
                            {msg.direction === 'in' ? customer.first_name : 'You'}
                          </span>
                          {': '}
                          {(msg.preview || msg.title).slice(0, 64)}
                        </>
                      )}
                    </p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {/* Manual Communication Log — the same two markers the full timeline uses
                          (CommRow), from the same atoms, because this card previews the same rows.
                          A reader glancing here must not be able to cite a typed-up note as
                          something ServWave recorded. */}
                      {msg.manuallyLogged && <LoggedChip />}
                      <span title={label} className="flex items-center">
                        <ChannelIcon channel={msg.channel} handEntered={msg.manuallyLogged} payment={isPayment} />
                        <span className="sr-only">{label}</span>
                      </span>
                      <time className="text-[11px] text-text-secondary/70 whitespace-nowrap">
                        {new Date(msg.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </time>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
