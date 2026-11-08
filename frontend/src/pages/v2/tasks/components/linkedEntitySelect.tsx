/**
 * LinkedEntitySelect - v2.
 *
 * Popover picker with a type toggle (JOB | LEAD | CUSTOMER | ESTIMATE) and a
 * debounced search box. Everything below the presentation is the legacy
 * component's, unchanged: the four label builders, the four list endpoints, the
 * `['linked-entity-search', activeType, debouncedQ]` query key with
 * `enabled: open` / `keepPreviousData` / `staleTime: 30_000`, the `leads`
 * entitlement gate that drops LEAD from the choices, and every `data-testid`.
 *
 * The kit's `form/combobox` was the obvious candidate and does not fit: it is a
 * single-list Command picker over static options with no second axis, and this
 * control's entity TYPE toggle re-points the query at a different endpoint.
 * Recorded in the gap ledger.
 */
import { useState, useEffect } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ChevronsUpDown, X } from 'lucide-react';

import api from '@/lib/axios';
import { formatPhone } from '@/lib/utils';
import type { LinkedEntity, LinkedEntityType } from '@/lib/tasks/types';
import { useFeature } from '@/lib/entitlements';

import { cn } from '@/ui-kit/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Input } from '@/ui-kit/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';

import { ELLIPSIS, EM_DASH } from './glyphs';

// -- Lite response shapes (list endpoints return more; only these are read) ---

interface JobLite {
  id: string;
  job_number: string;
  job_type: string | null;
  customer: { first_name: string | null; last_name: string | null; company_name: string | null; phone: string | null } | null;
  service_location: { address_line1: string | null; city: string | null; state: string | null } | null;
}

interface LeadLite {
  id: string;
  lead_number: string;
  service_request: string | null;
  job_type: string | null;
  service_city: string | null;
  service_state: string | null;
  customer: {
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    phone: string | null;
    service_locations?: { city: string | null; state: string | null }[];
  } | null;
}

interface CustomerLite {
  id: string;
  customer_number: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
}

interface EstimateLite {
  id: string;
  estimate_number: string;
  lead: {
    customer: { first_name: string | null; last_name: string | null; company_name: string | null } | null;
  } | null;
}

// -- Label builders, byte-for-byte the originals ------------------------------

function customerName(c: { first_name: string | null; last_name: string | null; company_name: string | null } | null): string {
  if (!c) return '';
  return c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '';
}

function phonePart(p: string | null | undefined): string {
  return p ? formatPhone(p) : '';
}

function cityState(city: string | null | undefined, state: string | null | undefined): string {
  return [city, state].filter(Boolean).join(', ');
}

function jobLabel(j: JobLite): string {
  const name = customerName(j.customer);
  const suffix = [
    j.job_type ?? '',
    name,
    phonePart(j.customer?.phone),
    cityState(j.service_location?.city, j.service_location?.state),
  ].filter(Boolean).join(' · ');
  return suffix ? `${j.job_number} · ${suffix}` : j.job_number;
}

function leadLabel(l: LeadLite): string {
  const name = customerName(l.customer);
  const primary = l.customer?.service_locations?.[0];
  const suffix = [
    l.job_type ?? '',
    name,
    phonePart(l.customer?.phone),
    // Lead-level service location is optional; fall back to the customer's primary.
    cityState(l.service_city, l.service_state) || cityState(primary?.city, primary?.state),
  ].filter(Boolean).join(' · ');
  return suffix ? `${l.lead_number} · ${suffix}` : l.lead_number;
}

function estimateLabel(e: EstimateLite): string {
  const name = customerName(e.lead?.customer ?? null);
  return name ? `${e.estimate_number} · ${name}` : e.estimate_number;
}

function customerLabel(c: CustomerLite): string {
  return c.company_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.customer_number;
}

// -- Helpers ------------------------------------------------------------------

const TYPE_OPTIONS: LinkedEntityType[] = ['JOB', 'LEAD', 'CUSTOMER', 'ESTIMATE'];

function typeLabel(t: LinkedEntityType): string {
  return { JOB: 'Job', LEAD: 'Lead', CUSTOMER: 'Customer', ESTIMATE: 'Estimate' }[t];
}

async function fetchEntities(type: LinkedEntityType, q: string): Promise<LinkedEntity[]> {
  const params = { ...(q ? { search: q } : {}), limit: 10 };

  if (type === 'JOB') {
    const { data } = await api.get<{ jobs: JobLite[] }>('/api/jobs', { params });
    return data.jobs.map((j) => ({ type: 'JOB' as const, id: j.id, label: jobLabel(j) }));
  }
  if (type === 'LEAD') {
    const { data } = await api.get<{ leads: LeadLite[] }>('/api/leads', { params });
    return data.leads.map((l) => ({ type: 'LEAD' as const, id: l.id, label: leadLabel(l) }));
  }
  if (type === 'ESTIMATE') {
    const { data } = await api.get<{ estimates: EstimateLite[] }>('/api/estimates', { params });
    return data.estimates.map((e) => ({ type: 'ESTIMATE' as const, id: e.id, label: estimateLabel(e) }));
  }
  const { data } = await api.get<{ customers: CustomerLite[] }>('/api/customers', { params });
  return data.customers.map((c) => ({ type: 'CUSTOMER' as const, id: c.id, label: customerLabel(c) }));
}

export interface LinkedEntitySelectProps {
  value: LinkedEntity | null;
  onChange: (entity: LinkedEntity | null) => void;
  disabled?: boolean;
}

export function LinkedEntitySelect({ value, onChange, disabled = false }: LinkedEntitySelectProps) {
  const [open, setOpen] = useState(false);
  const [activeType, setActiveType] = useState<LinkedEntityType>(value?.type ?? 'JOB');
  // LEAD is the only Pro-gated entity type here; the other three are Starter
  // core. Offering it without the entitlement gives a picker that can only ever
  // come back empty, so it is dropped from the choices instead. An
  // already-linked lead still displays - `value` is untouched.
  const hasLeads = useFeature('leads');
  const typeOptions = hasLeads ? TYPE_OPTIONS : TYPE_OPTIONS.filter((t) => t !== 'LEAD');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Keep activeType in sync when an external value is set (e.g. presetEntity).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- `activeType` is the user's own tab choice inside the picker and has to survive browsing away from the linked value's type, so it cannot be derived from the prop; it only follows `value` when the parent sets one
    if (value?.type) setActiveType(value.type);
  }, [value?.type]);

  const { data: entities = [] } = useQuery({
    queryKey: ['linked-entity-search', activeType, debouncedQ],
    queryFn: () => fetchEntities(activeType, debouncedQ),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  function handleSelect(entity: LinkedEntity) {
    onChange(entity);
    setOpen(false);
    setQ('');
  }

  const triggerLabel = value ? `[${value.type}] ${value.label}` : `${EM_DASH} None ${EM_DASH}`;

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={disabled ? () => {} : setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="flex-1 justify-between gap-2 font-normal"
            data-testid="linked-entity-select-trigger"
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-80">
          {/* Segmented type toggle. Each option re-points the query at a
              different endpoint, so it is a control, not a filter chip. */}
          <div className="mb-2 flex flex-wrap gap-1">
            {typeOptions.map((t) => (
              <Button
                key={t}
                type="button"
                size="sm"
                variant={activeType === t ? 'default' : 'ghost'}
                data-testid={`type-toggle-${t}`}
                onClick={() => { setActiveType(t); setQ(''); }}
              >
                {typeLabel(t)}
              </Button>
            ))}
          </div>

          <Input
            autoFocus
            placeholder={`Search ${typeLabel(activeType).toLowerCase()}s${ELLIPSIS}`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="mb-2 h-8.5"
            data-testid="linked-entity-search-input"
          />

          <div className="max-h-56 overflow-y-auto">
            {entities.length === 0 ? (
              <EmptyState title="No matches" />
            ) : (
              entities.map((entity) => (
                <Button
                  key={entity.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid={`entity-option-${entity.id}`}
                  className={cn('w-full justify-start font-normal')}
                  onClick={() => handleSelect(entity)}
                >
                  <span className="truncate">{entity.label}</span>
                </Button>
              ))
            )}
          </div>

          {value && (
            <div className="border-input mt-1 border-t pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={() => { onChange(null); setOpen(false); }}
              >
                Clear selection
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {value && !disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(null)}
          aria-label="Clear linked entity"
        >
          <X />
        </Button>
      )}
    </div>
  );
}
