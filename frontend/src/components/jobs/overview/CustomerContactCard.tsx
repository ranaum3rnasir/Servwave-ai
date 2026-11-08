import { Link } from 'react-router-dom';
import { Phone, Mail, Map, MessageSquare } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn, formatPhone, getInitials } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
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

// ─── Component ─────────────────────────────────────────────────────────────────

export function CustomerContactCard({ job, onViewAllCommunications }: CustomerContactCardProps) {
  const { customer, service_location: loc } = job;
  const ability = useAppAbility();
  const canReadComms = ability.can('read', 'Communication');
  // In-app call entry (E2): only when the org can use the comms module AND the
  // user holds the `create Communication` grant (not a role check) — everyone
  // else (a user without that grant, a locked org) keeps the native tel: link,
  // which can never 403.
  const canAccessComms = useFeature('phone');
  const canPlaceCall = canAccessComms && ability.can('create', 'Communication');

  const name = customerDisplayName(customer);
  const callContext = {
    jobId: job.id,
    jobLabel: job.job_number,
    customerId: customer.id,
    customerName: name,
  };

  // Build google maps query from service location
  const mapQuery = loc
    ? encodeURIComponent(
        [loc.address_line1, loc.address_line2, loc.city, loc.state, loc.zip]
          .filter(Boolean)
          .join(', '),
      )
    : customer.phone
      ? encodeURIComponent(name)
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
            {canPlaceCall ? (
              // Left raw: idle colour is inherited from the ambient <p> (no colour of its
              // own), hover adds text-primary + underline with no background - ghost/neutral
              // sets no idle colour either but its hover adds an unwanted background tint
              // and targets text-text-primary, not brand primary; no cell reproduces this
              // exact "inherit, then underline+brand on hover" pair.
              <button
                type="button"
                onClick={() => requestCall(customer.phone, callContext)}
                className="hover:text-primary hover:underline"
              >
                {formatPhone(customer.phone)}
              </button>
            ) : (
              <a
                href={`tel:${customer.phone}`}
                className="hover:text-primary hover:underline"
              >
                {formatPhone(customer.phone)}
              </a>
            )}
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

      {/* Action buttons */}
      <div className="grid grid-cols-4 gap-2">
        {customer.phone &&
          (canPlaceCall ? (
            // Left raw: must render pixel-identical to the sibling Text/Email/Map <a>
            // tiles in this same grid (same stacked icon+label tile), which are outside
            // Button's reach - converting only this one would break the grid's visual
            // consistency.
            <button
              type="button"
              onClick={() => requestCall(customer.phone, callContext)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border border-border bg-background-light/40 py-2 px-1',
                'text-[11px] font-medium text-text-secondary hover:text-primary hover:border-primary/40 transition-colors',
              )}
            >
              <Phone className="h-4 w-4" />
              Call
            </button>
          ) : (
            <a
              href={`tel:${customer.phone}`}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border border-border bg-background-light/40 py-2 px-1',
                'text-[11px] font-medium text-text-secondary hover:text-primary hover:border-primary/40 transition-colors',
              )}
            >
              <Phone className="h-4 w-4" />
              Call
            </a>
          ))}
        {customer.phone && (
          <a
            href={
              canAccessComms
                ? `/communication/text?customerId=${customer.id}`
                : `sms:${customer.phone}`
            }
            className={cn(
              'flex flex-col items-center gap-1 rounded-lg border border-border bg-background-light/40 py-2 px-1',
              'text-[11px] font-medium text-text-secondary hover:text-primary hover:border-primary/40 transition-colors',
            )}
          >
            <MessageSquare className="h-4 w-4" />
            Text
          </a>
        )}
        {customer.email && (
          <a
            href={`mailto:${customer.email}`}
            className={cn(
              'flex flex-col items-center gap-1 rounded-lg border border-border bg-background-light/40 py-2 px-1',
              'text-[11px] font-medium text-text-secondary hover:text-primary hover:border-primary/40 transition-colors',
            )}
          >
            <Mail className="h-4 w-4" />
            Email
          </a>
        )}
        {mapQuery && (
          <a
            href={`https://maps.google.com/?q=${mapQuery}`}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'flex flex-col items-center gap-1 rounded-lg border border-border bg-background-light/40 py-2 px-1',
              'text-[11px] font-medium text-text-secondary hover:text-primary hover:border-primary/40 transition-colors',
            )}
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
