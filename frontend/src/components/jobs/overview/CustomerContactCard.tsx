import { Link } from 'react-router-dom';
import { Phone, Mail, Map, MessageSquare } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn, getInitials } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { useAppAbility } from '@/contexts/AbilityContext';
import { ContactCallButton, ContactTextButton, PhoneNumberAction } from '@/components/contact/ContactAction';
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
import api from '@/lib/axios';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string | null;
  phone: string;
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
  };
  onViewAllCommunications?: () => void;
}

// The stacked icon + label tile the Call, Text, Email and Map actions share. Left as plain elements
// rather than Buttons: all four must render pixel-identical in this one grid, and the tile look is
// outside Button's reach.
const TILE_CLASS = cn(
  'flex flex-col items-center gap-1 rounded-lg border border-border bg-background-light/40 py-2 px-1',
  'text-[11px] font-medium text-text-secondary hover:text-primary hover:border-primary/40 transition-colors',
);

// ─── Component ─────────────────────────────────────────────────────────────────

export function CustomerContactCard({ job, onViewAllCommunications }: CustomerContactCardProps) {
  const { customer, service_location: loc } = job;
  const ability = useAppAbility();
  const canReadComms = ability.can('read', 'Communication');
  // In-app call entry (E2) is the contact action's decision now: the dialer when the org has the
  // phone service AND the user holds the `create Communication` grant (not a role check); everyone
  // else (a user without that grant, a locked org) keeps the device's own call link, which can never 403.

  const name = customerDisplayName(customer);
  const callContext = {
    jobId: job.id,
    jobLabel: job.job_number,
    customerId: customer.id,
    customerName: name,
  };

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

  const initials = getInitials(name);

  return (
    <SectionCard title="Customer &amp; Contact" bodyClassName="space-y-4">
      {/* Monogram + Name + company — center so the name sits on the monogram's axis */}
      <div className="flex items-center gap-3">
        {/* Initials monogram */}
        <div className="shrink-0 h-10 w-10 rounded-full bg-primary ring-2 ring-surface-light shadow-sm flex items-center justify-center">
          <span className="text-xs font-semibold text-on-fill tracking-wide">{initials}</span>
        </div>
        <div>
          <Link
            to={`/customers/${customer.id}`}
            className="text-sm font-medium text-primary hover:underline"
          >
            {name}
          </Link>
          {customer.company_name && (
            <p className="text-xs text-text-secondary mt-0.5">{customer.company_name}</p>
          )}
        </div>
      </div>

      {/* Contact details */}
      <div className="space-y-1.5">
        {customer.phone && (
          <p className="text-sm text-text-secondary flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5 shrink-0" />
            <PhoneNumberAction
              phone={customer.phone}
              name={name}
              context={callContext}
            />
          </p>
        )}
        {customer.email && (
          <p className="text-sm text-text-secondary flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5 shrink-0" />
            <a
              href={`mailto:${customer.email}`}
              className="hover:text-primary hover:underline truncate"
            >
              {customer.email}
            </a>
          </p>
        )}
      </div>

      {/* Action buttons. Two across on a narrow phone, so each tile is a thumb-sized target (a
          four-across row left each one about 33 px wide at 320 px); four across from sm up. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {customer.phone && (
          <ContactCallButton
            kind="bare"
            phone={customer.phone}
            context={callContext}
            className={TILE_CLASS}
          >
            <Phone className="h-4 w-4" />
            Call
          </ContactCallButton>
        )}
        {customer.phone && (
          <ContactTextButton kind="bare" phone={customer.phone} context={callContext} className={TILE_CLASS}>
            <MessageSquare className="h-4 w-4" />
            Text
          </ContactTextButton>
        )}
        {customer.email && (
          <a
            href={`mailto:${customer.email}`}
            className={TILE_CLASS}
          >
            <Mail className="h-4 w-4" />
            Email
          </a>
        )}
        {mapQuery && (
          <a
            href={mapsHref(mapQuery, { ios: isIosDevice() })}
            target="_blank"
            rel="noopener noreferrer"
            className={TILE_CLASS}
          >
            <Map className="h-4 w-4" />
            Map
          </a>
        )}
      </div>

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
                const label = channelLabel(msg.channel);
                return (
                  <div key={msg.id} className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-xs text-text-secondary">
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
                    </p>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {/* Manual Communication Log — the same two markers the full timeline uses
                          (CommRow), from the same atoms, because this card previews the same rows.
                          A reader glancing here must not be able to cite a typed-up note as
                          something ServWave recorded. */}
                      {msg.manuallyLogged && <LoggedChip />}
                      <span title={label} className="flex items-center">
                        <ChannelIcon channel={msg.channel} handEntered={msg.manuallyLogged} />
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
