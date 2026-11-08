/**
 * LinkedEntitySelect
 *
 * Popover-based picker (clones CustomerSelect pattern) with a type toggle
 * (JOB | LEAD | CUSTOMER | ESTIMATE) and a debounced search box.
 *
 * All four list endpoints support ?search=:
 *   GET /api/jobs?search=&limit=      → { jobs: [...] }
 *   GET /api/leads?search=&limit=     → { leads: [...] }
 *   GET /api/customers?search=&limit= → { customers: [...] }
 *   GET /api/estimates?search=&limit= → { estimates: [...] }
 *
 * The emitted label is a human-readable string so it populates
 * linked_entity.label on the Task row.
 */
import { useState, useEffect } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { ChevronsUpDown, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import api from '@/lib/axios';
import { formatPhone } from '@/lib/utils';
import type { LinkedEntity, LinkedEntityType } from '@/lib/tasks/types';
import { useFeature } from '@/lib/entitlements';
import { useScrollLockEscape } from '@/hooks/useScrollLockEscape';

// ── Lite response shapes (list endpoints return more fields; we only need these) ──

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

// ── Label builders ────────────────────────────────────────────────────────────

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
    // Lead-level service location is optional; fall back to the customer's primary location.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_OPTIONS: LinkedEntityType[] = ['JOB', 'LEAD', 'CUSTOMER', 'ESTIMATE'];

function typeLabel(t: LinkedEntityType): string {
  return { JOB: 'Job', LEAD: 'Lead', CUSTOMER: 'Customer', ESTIMATE: 'Estimate' }[t];
}

// ── Query fetcher ─────────────────────────────────────────────────────────────

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
  // CUSTOMER
  const { data } = await api.get<{ customers: CustomerLite[] }>('/api/customers', { params });
  return data.customers.map((c) => ({ type: 'CUSTOMER' as const, id: c.id, label: customerLabel(c) }));
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface LinkedEntitySelectProps {
  value: LinkedEntity | null;
  onChange: (entity: LinkedEntity | null) => void;
  disabled?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LinkedEntitySelect({ value, onChange, disabled = false }: LinkedEntitySelectProps) {
  const [open, setOpen] = useState(false);
  const [activeType, setActiveType] = useState<LinkedEntityType>(value?.type ?? 'JOB');
  // LEAD is the only Pro-gated entity type here; the other three are Starter core.
  // Offering it without the entitlement gives a picker that can only ever come back
  // empty, so it is dropped from the choices instead. An already-linked lead (set
  // before a downgrade, or via presetEntity) still displays - `value` is untouched.
  const hasLeads = useFeature('leads');
  const typeOptions = hasLeads ? TYPE_OPTIONS : TYPE_OPTIONS.filter((t) => t !== 'LEAD');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  // Debounce the query
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Keep activeType in sync when an external value is set (e.g. presetEntity)
  useEffect(() => {
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

  function handleClear() {
    onChange(null);
  }

  const triggerLabel = value ? `[${value.type}] ${value.label}` : '— None —';

  // The results list is portalled outside any surrounding Dialog's scroll lock,
  // which would otherwise swallow its wheel/touch events - see the hook.
  const attachScrollLockEscape = useScrollLockEscape();

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={disabled ? () => {} : setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="flex-1 justify-between gap-2 text-sm font-normal"
            data-testid="linked-entity-select-trigger"
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-80 p-2">
          {/* Type toggle */}
          <div className="mb-2 flex gap-1 flex-wrap">
            {typeOptions.map((t) => (
              // Segmented type-toggle control (two-state bg-primary vs bg-background-light
              // pill), not Button-shaped - left raw.
              <button
                key={t}
                type="button"
                data-testid={`type-toggle-${t}`}
                onClick={() => { setActiveType(t); setQ(''); }}
                className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                  activeType === t
                    ? 'bg-primary text-on-fill'
                    : 'bg-background-light text-text-secondary hover:bg-background-light/80'
                }`}
              >
                {typeLabel(t)}
              </button>
            ))}
          </div>

          {/* Search box */}
          <Input
            autoFocus
            placeholder={`Search ${typeLabel(activeType).toLowerCase()}s…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="mb-2 h-8"
            data-testid="linked-entity-search-input"
          />

          {/* Results */}
          <div
            ref={attachScrollLockEscape}
            data-testid="linked-entity-results"
            className="max-h-56 overflow-y-auto overscroll-contain"
          >
            {entities.length === 0 ? (
              <EmptyState density="flush" title="No matches" />
            ) : (
              entities.map((entity) => (
                // Dropdown-menu-item result row, not Button-shaped - left raw.
                <button
                  key={entity.id}
                  type="button"
                  data-testid={`entity-option-${entity.id}`}
                  className="block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-background-light"
                  onClick={() => handleSelect(entity)}
                >
                  {entity.label}
                </button>
              ))
            )}
          </div>

          {/* Clear option */}
          {value && (
            <div className="mt-1 border-t border-border pt-1">
              {/* Dropdown-menu-item row (also carries an explicit idle text-text-secondary
                  that outline/neutral would silently drop - button.tsx's own trap note),
                  not Button-shaped - left raw. */}
              <button
                type="button"
                className="block w-full rounded px-2 py-1 text-left text-xs text-text-secondary hover:bg-background-light"
                onClick={() => { onChange(null); setOpen(false); }}
              >
                Clear selection
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* Clear pill outside the popover */}
      {value && !disabled && (
        // Small close-X affordance, not Button-shaped - left raw.
        <button
          type="button"
          className="rounded p-0.5 hover:bg-background-light"
          onClick={handleClear}
          aria-label="Clear linked entity"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
