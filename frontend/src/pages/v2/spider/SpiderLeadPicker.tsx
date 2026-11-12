import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ChevronDown, Loader2, MapPin, Undo2, User, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Heading } from '@/components/ui/heading';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { toast } from '@/ui-kit/components/ui/sonner';
import { HelpIcon } from '@/components/permissions/HelpIcon';
import { LoadError } from '../_shared/loadError';
import { cn } from '@/lib/utils';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { spiderErrorText } from '@/lib/spider/errorText';
import {
  SPIDER_PICKER_KEY,
  fetchAllSpiderCustomerLeads,
  spiderCustomerLeadsKey,
  useSpiderCustomerLeads,
  useSpiderExcludedLeads,
  useSpiderPickerCustomers,
  type SpiderExcludedLead,
  type SpiderPickerCustomer,
  type SpiderPickerLead,
  type SpiderPickerOverview,
} from '@/lib/api/spider';

/*
 * "Select Contacts for Alert" as mockup M2 draws it (#3436; Ran, 10 Nov: Q4 A, Q5 A, the words Exclude / Excluded /
 * Include again). Every open lead is watched, new ones included, except the excluded ones (Ran, 3 Nov). The picker never
 * downloads the whole list: the customers with open leads come 50 at a time from the server, searched there, a customer's
 * leads load when its row is opened, and the Excluded tab is paged the same way. A tick never saves by itself: the page
 * keeps it as a change (`changes`) until its Save sends them all in one request. One customer or lead at a time (no bulk
 * exclude).
 */

/** The ? beside the header line (mockup M2, word for word). */
export const SPIDER_WATCHING_HELP = 'Every open lead is watched, new ones included. Exclude a lead or a whole customer to leave it out.';

/** One change not saved yet: the lead is now to be excluded (or included again), and whose lead it is when known. */
export interface SpiderExclusionChange {
  excluded: boolean;
  customerId: string | null;
}

/** A tick on a lead: what the server holds for it, and what the person wants now. */
export interface SpiderLeadTick {
  leadId: string;
  customerId: string | null;
  serverExcluded: boolean;
  excluded: boolean;
}

/**
 * The unsaved changes, tallied by the customer they belong to: +1 for each lead to be excluded, -1 for each to be included
 * again (a change always differs from what the server holds). Tallied once per render for every row, instead of each
 * customer row scanning all the changes. A change whose customer is not known yet is left out, as before.
 */
function pendingExclusionsByCustomer(changes: Record<string, SpiderExclusionChange>): Map<string, number> {
  const byCustomer = new Map<string, number>();
  for (const ch of Object.values(changes)) {
    if (!ch.customerId) continue;
    byCustomer.set(ch.customerId, (byCustomer.get(ch.customerId) ?? 0) + (ch.excluded ? 1 : -1));
  }
  return byCustomer;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const statusLabel = (status: string) => STATUS_REGISTRY.lead[status]?.label ?? status;

/** "2 Hours in stage", as the page has always written it; null for a lead in none of Spider's stages. */
export function timeInStage(enteredAt: string | null, now = Date.now()): string | null {
  const from = enteredAt ? Date.parse(enteredAt) : NaN;
  if (!Number.isFinite(from)) return null;
  const s = Math.max(0, Math.floor((now - from) / 1000));
  const [value, unit] =
    s >= 86_400 ? [Math.floor(s / 86_400), 'Day'] : s >= 3_600 ? [Math.floor(s / 3_600), 'Hour'] : s >= 60 ? [Math.floor(s / 60), 'Minute'] : [Math.max(1, s), 'Second'];
  return `${value} ${unit}${value > 1 ? 's' : ''} in stage`;
}

/** The end of a paged list: shows the mockup's loading line while pages remain, and asks for the next one in view. */
function LoadMoreRow({
  hasMore,
  loading,
  failed,
  onLoadMore,
  label,
  failedTitle,
}: {
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  onLoadMore: () => void;
  label: string;
  failedTitle: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const watching = hasMore && !loading && !failed;
  useEffect(() => {
    const el = sentinel.current;
    if (!watching || !el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [watching, onLoadMore]);
  if (failed) return <LoadError title={failedTitle} onRetry={onLoadMore} retrying={loading} className="py-4" />;
  if (!hasMore) return null;
  return (
    <div ref={sentinel} data-spider-load-more className="flex justify-center p-2.5">
      <p className="flex items-center gap-2 text-xs text-text-soft" aria-live="polite">
        <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
        {label}
      </p>
    </div>
  );
}

/** '38 customers with open leads match "bro"' (mockup M2); one is '1 customer with open leads matches "bro"'. */
export function searchTotalLine(total: number, q: string): string {
  return total === 1
    ? `1 customer with open leads matches "${q}"`
    : `${total.toLocaleString('en-US')} customers with open leads match "${q}"`;
}

const flat = <T,>(data: InfiniteData<{ rows: T[] }> | undefined): T[] => data?.pages.flatMap((p) => p.rows) ?? [];

export interface SpiderLeadPickerProps {
  overview: SpiderPickerOverview | undefined;
  overviewFailed: boolean;
  onRetryOverview: () => void;
  /** The changes not saved yet, by lead id. */
  changes: Record<string, SpiderExclusionChange>;
  onTicks: (ticks: SpiderLeadTick[]) => void;
  onOpenLead: (leadId: string) => void;
}

export function SpiderLeadPicker({ overview, overviewFailed, onRetryOverview, changes, onTicks, onOpenLead }: SpiderLeadPickerProps) {
  const [tab, setTab] = useState<'customers' | 'excluded'>('customers');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerQuery, setCustomerQuery] = useState('');
  const [excludedSearch, setExcludedSearch] = useState('');
  const [excludedQuery, setExcludedQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [ticking, setTicking] = useState<ReadonlySet<string>>(new Set());
  const qc = useQueryClient();

  const customers = useSpiderPickerCustomers(customerQuery.trim(), { enabled: tab === 'customers' });
  const excluded = useSpiderExcludedLeads(excludedQuery.trim(), { enabled: tab === 'excluded' });

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** The customer whose leads, already read, include this one; null when none read so far does. */
  const customerOfLead = (leadId: string): string | null => {
    for (const [key, data] of qc.getQueriesData<InfiniteData<{ rows: SpiderPickerLead[] }>>({
      queryKey: [...SPIDER_PICKER_KEY, 'customer-leads'],
    })) {
      if (flat(data).some((l) => l.id === leadId)) return String(key[3]);
    }
    return null;
  };

  const pendingByCustomer = pendingExclusionsByCustomer(changes);

  /** Ticking a customer ticks all its open leads; unticking excludes them all (one customer at a time). */
  const tickCustomer = async (c: SpiderPickerCustomer, exclude: boolean) => {
    const cached = qc.getQueryData<InfiniteData<{ rows: SpiderPickerLead[]; next_cursor: string | null }>>(spiderCustomerLeadsKey(c.id));
    let leads: SpiderPickerLead[];
    if (cached && cached.pages[cached.pages.length - 1]?.next_cursor === null) {
      leads = flat(cached);
    } else {
      setTicking((prev) => new Set(prev).add(c.id));
      try {
        leads = await fetchAllSpiderCustomerLeads(c.id);
      } catch (err) {
        toast.error(spiderErrorText(err, "Could not load this customer's leads."));
        return;
      } finally {
        setTicking((prev) => {
          const next = new Set(prev);
          next.delete(c.id);
          return next;
        });
      }
    }
    onTicks(leads.map((l) => ({ leadId: l.id, customerId: c.id, serverExcluded: l.excluded, excluded: exclude })));
  };

  const customerRows = flat(customers.data);
  // Mockup M2: '38 customers with open leads match "bro"', for the search the server answered.
  const searchedFor = customerQuery.trim();
  const searchTotal = searchedFor ? (customers.data?.pages[0]?.total ?? null) : null;
  const excludedRows = flat(excluded.data);
  const loadMoreCustomers = useStableLoadMore(customers.fetchNextPage);
  const loadMoreExcluded = useStableLoadMore(excluded.fetchNextPage);

  return (
    <div className="rounded-card border border-border bg-surface-light p-4 shadow-card" data-spider-picker>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-2.5">
        <Heading level={3} scale="sm" weight="bold" className="flex items-center gap-2">
          <Users className="h-4 w-4 shrink-0 text-ai-600" />
          Select Contacts for Alert
        </Heading>
        <div data-spider-picker-count className="flex flex-wrap items-center gap-1 text-[13px] text-text-secondary">
          {overview ? (
            <>
              <span>
                Watching <b className="tabular-nums text-text-primary">{overview.watched.toLocaleString()}</b>{' '}
                {overview.watched === 1 ? 'open lead' : 'open leads'} ·{' '}
              </span>
              <button
                type="button"
                onClick={() => setTab('excluded')}
                className="font-bold text-ai-600 hover:text-ai-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500 rounded"
              >
                {overview.excluded.toLocaleString()} excluded
              </button>
              <HelpIcon label="watching" ariaLabel="How watching works" text={SPIDER_WATCHING_HELP} />
            </>
          ) : overviewFailed ? (
            <span role="alert" className="flex items-center gap-2 text-danger-text">
              Couldn't load the counts.
              <Button type="button" variant="outline" size="sm" onClick={onRetryOverview}>
                Retry
              </Button>
            </span>
          ) : (
            <Skeleton aria-hidden data-spider-picker-count-loading className="h-4 w-48" />
          )}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2.5">
        <div role="tablist" aria-label="Leads" className="inline-flex shrink-0 gap-0.5 rounded-[10px] border border-border bg-background-light p-[3px]">
          {(['customers', 'excluded'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-[12.5px] font-bold transition-colors',
                tab === t ? 'bg-surface-light text-text-primary shadow-xs' : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {t === 'customers' ? 'Customers' : 'Excluded'}
              {t === 'excluded' && overview && (
                <span className="rounded-full border border-warning-border bg-warning-surface px-1.5 text-[11px] text-warning-text">
                  {overview.excluded.toLocaleString()}
                </span>
              )}
            </button>
          ))}
        </div>
        {tab === 'customers' ? (
          <SearchInput
            key="customers"
            value={customerSearch}
            onValueChange={setCustomerSearch}
            onDebouncedChange={setCustomerQuery}
            placeholder="Search customers"
            aria-label="Search customers"
            className="min-w-[220px] flex-1"
          />
        ) : (
          <SearchInput
            key="excluded"
            value={excludedSearch}
            onValueChange={setExcludedSearch}
            onDebouncedChange={setExcludedQuery}
            placeholder="Search excluded leads"
            aria-label="Search excluded leads"
            className="min-w-[220px] flex-1"
          />
        )}
      </div>
      {tab === 'customers' && (
        <p className="mb-2 flex justify-between gap-3 text-xs text-text-soft">
          <span data-spider-search-total>{searchTotal ? searchTotalLine(searchTotal, searchedFor) : null}</span>
          <span>Name, company, lead # or phone</span>
        </p>
      )}

      {tab === 'customers' ? (
        <div
          data-spider-picker-list
          tabIndex={0}
          aria-label="Customers with open leads"
          className="grid max-h-[392px] gap-2 overflow-y-auto pr-1"
        >
          {customers.isPending ? (
            <ListSkeleton />
          ) : customers.isError && customerRows.length === 0 ? (
            <LoadError title="Couldn't load customers." onRetry={() => void customers.refetch()} retrying={customers.isFetching} className="py-6" />
          ) : customerRows.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-soft">
              {customerQuery.trim() ? 'No contacts or leads found matching your search.' : 'No customers with open leads.'}
            </p>
          ) : (
            <>
              {customerRows.map((c) => (
                <CustomerRow
                  key={c.id}
                  customer={c}
                  open={open.has(c.id)}
                  busy={ticking.has(c.id)}
                  pendingExcluded={pendingByCustomer.get(c.id) ?? 0}
                  changes={changes}
                  onToggleOpen={() => toggleOpen(c.id)}
                  onTickCustomer={(exclude) => void tickCustomer(c, exclude)}
                  onTicks={onTicks}
                  onOpenLead={onOpenLead}
                />
              ))}
              <LoadMoreRow
                hasMore={customers.hasNextPage}
                loading={customers.isFetchingNextPage}
                failed={customers.isFetchNextPageError}
                onLoadMore={loadMoreCustomers}
                label="Loading more customers"
                failedTitle="Couldn't load more customers."
              />
            </>
          )}
        </div>
      ) : (
        <div data-spider-excluded-list tabIndex={0} aria-label="Excluded leads" className="grid max-h-[392px] gap-2 overflow-y-auto pr-1">
          {excluded.isPending ? (
            <ListSkeleton />
          ) : excluded.isError && excludedRows.length === 0 ? (
            <LoadError title="Couldn't load excluded leads." onRetry={() => void excluded.refetch()} retrying={excluded.isFetching} className="py-6" />
          ) : excludedRows.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-soft">
              {excludedQuery.trim() ? 'No contacts or leads found matching your search.' : 'No excluded leads.'}
            </p>
          ) : (
            <>
              {excludedRows.map((l) => (
                <ExcludedRow
                  key={l.id}
                  lead={l}
                  excludedNow={changes[l.id]?.excluded ?? true}
                  onTick={(exclude) =>
                    onTicks([{ leadId: l.id, customerId: l.customer_id ?? changes[l.id]?.customerId ?? customerOfLead(l.id), serverExcluded: true, excluded: exclude }])
                  }
                />
              ))}
              <LoadMoreRow
                hasMore={excluded.hasNextPage}
                loading={excluded.isFetchingNextPage}
                failed={excluded.isFetchNextPageError}
                onLoadMore={loadMoreExcluded}
                label="Loading more excluded leads"
                failedTitle="Couldn't load more excluded leads."
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A stable "next page" callback, so the end-of-list watcher is not rebuilt on every render. */
function useStableLoadMore(fetchNextPage: () => Promise<unknown>) {
  const ref = useRef(fetchNextPage);
  useEffect(() => {
    ref.current = fetchNextPage;
  });
  return useCallback(() => void ref.current(), []);
}

function ListSkeleton() {
  return (
    <div aria-hidden data-spider-picker-loading className="grid gap-2">
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-12 w-full rounded-lg" />
    </div>
  );
}

function Chip({ tone = 'ai', children }: { tone?: 'ai' | 'warn' | 'grey'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold',
        tone === 'warn' && 'border-warning-border bg-warning-surface text-warning-text',
        tone === 'grey' && 'border-border bg-surface-light text-text-secondary',
        tone === 'ai' && 'border-ai-200 bg-ai-50 text-ai-strong',
      )}
    >
      {children}
    </span>
  );
}

function CustomerRow({
  customer: c,
  open,
  busy,
  pendingExcluded,
  changes,
  onToggleOpen,
  onTickCustomer,
  onTicks,
  onOpenLead,
}: {
  customer: SpiderPickerCustomer;
  open: boolean;
  busy: boolean;
  /** The net unsaved change to this customer's excluded leads (see pendingExclusionsByCustomer). */
  pendingExcluded: number;
  changes: Record<string, SpiderExclusionChange>;
  onToggleOpen: () => void;
  onTickCustomer: (exclude: boolean) => void;
  onTicks: (ticks: SpiderLeadTick[]) => void;
  onOpenLead: (leadId: string) => void;
}) {
  // The server's counts, with the changes not saved yet on this customer's leads.
  const excludedCount = Math.min(c.open_leads, Math.max(0, c.excluded_leads + pendingExcluded));
  const watched = c.open_leads - excludedCount;
  const checked: boolean | 'indeterminate' = watched === c.open_leads ? true : watched === 0 ? false : 'indeterminate';

  return (
    <div data-spider-customer={c.id} className="rounded-lg border border-border/70 bg-surface-light">
      <div
        className={cn(
          'flex cursor-pointer items-center gap-3 rounded-lg p-2.5 hover:bg-background-light',
          open && 'rounded-b-none border-b border-border/40 bg-background-light/70',
        )}
        onClick={onToggleOpen}
      >
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={checked}
            disabled={busy}
            onCheckedChange={() => onTickCustomer(checked === true)}
            aria-label={`Customer ${c.name}`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-[13px] font-bold', watched === 0 ? 'text-text-secondary' : 'text-text-primary')}>{c.name}</p>
          {c.email && <p className="truncate text-[11.5px] text-text-soft">{c.email}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {excludedCount > 0 && <Chip tone="warn">{excludedCount.toLocaleString()} excluded</Chip>}
          <Chip tone={watched === 0 ? 'grey' : 'ai'}>{plural(c.open_leads, 'lead', 'leads')}</Chip>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Toggle leads for ${c.name}`}
            aria-expanded={open}
            onClick={(e) => {
              e.stopPropagation();
              onToggleOpen();
            }}
            className="h-6 w-6 p-0"
          >
            <ChevronDown className={cn('h-4 w-4 text-text-soft transition-transform duration-200', open && 'rotate-180 text-ai-600')} />
          </Button>
        </div>
      </div>
      {open && <CustomerLeads customerId={c.id} changes={changes} onTicks={onTicks} onOpenLead={onOpenLead} />}
    </div>
  );
}

function CustomerLeads({
  customerId,
  changes,
  onTicks,
  onOpenLead,
}: {
  customerId: string;
  changes: Record<string, SpiderExclusionChange>;
  onTicks: (ticks: SpiderLeadTick[]) => void;
  onOpenLead: (leadId: string) => void;
}) {
  const leads = useSpiderCustomerLeads(customerId);
  const rows = flat(leads.data);
  const loadMore = useStableLoadMore(leads.fetchNextPage);
  return (
    <div data-spider-customer-leads className="space-y-1.5 border-t border-border/40 bg-background-light/40 p-2.5">
      {leads.isPending ? (
        <div data-spider-customer-leads-loading>
          <p className="flex items-center gap-2 px-0.5 py-1 text-xs text-text-soft">
            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
            Loading this customer's leads
          </p>
          <Skeleton aria-hidden className="mt-1.5 h-9 w-full rounded-md" />
          <Skeleton aria-hidden className="mt-1.5 h-9 w-full rounded-md" />
        </div>
      ) : leads.isError && rows.length === 0 ? (
        <LoadError title="Couldn't load this customer's leads." onRetry={() => void leads.refetch()} retrying={leads.isFetching} className="py-4" />
      ) : (
        <>
          {rows.map((l) => {
            const excludedNow = changes[l.id]?.excluded ?? l.excluded;
            const time = timeInStage(l.stage_entered_at);
            return (
              <div
                key={l.id}
                data-spider-lead={l.id}
                className={cn(
                  'flex items-center gap-2.5 rounded-md border p-2',
                  excludedNow ? 'border-border/60 bg-surface-light' : 'border-ai-200 bg-ai-50/40',
                )}
              >
                <Checkbox
                  checked={!excludedNow}
                  onCheckedChange={() =>
                    onTicks([{ leadId: l.id, customerId, serverExcluded: l.excluded, excluded: !excludedNow }])
                  }
                  aria-label={`Lead ${l.lead_number}`}
                />
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => onOpenLead(l.id)}
                    className="h-auto p-0"
                    aria-label={`Open Lead Overview for ${l.lead_number}`}
                  >
                    <span className={cn('font-mono text-xs font-bold', excludedNow && 'text-text-soft')}>{l.lead_number}</span>
                  </Button>
                  <span
                    className={cn(
                      'rounded border px-1.5 py-0.5 text-[10px] font-bold',
                      excludedNow ? 'border-border bg-surface-light text-text-soft' : 'border-ai-200 bg-ai-50 text-ai-strong',
                    )}
                  >
                    {statusLabel(l.status)}
                  </span>
                  {time && <span className={cn('text-[11px]', excludedNow ? 'text-text-soft' : 'text-text-secondary')}>{time}</span>}
                  {l.address && (
                    <span className={cn('inline-flex min-w-0 items-center gap-1 text-[11px]', excludedNow ? 'text-text-soft' : 'text-text-secondary')}>
                      <MapPin aria-hidden className="h-3 w-3 shrink-0" />
                      <span className="truncate">{l.address}</span>
                    </span>
                  )}
                  {excludedNow && <span className="text-[11px] font-bold text-warning-text">Excluded</span>}
                </div>
                {l.owner_name && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-surface-light px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                    <User aria-hidden className="h-3 w-3 text-text-soft" />
                    {l.owner_name}
                  </span>
                )}
              </div>
            );
          })}
          <LoadMoreRow
            hasMore={leads.hasNextPage}
            loading={leads.isFetchingNextPage}
            failed={leads.isFetchNextPageError}
            onLoadMore={loadMore}
            label="Loading this customer's leads"
            failedTitle="Couldn't load this customer's leads."
          />
        </>
      )}
    </div>
  );
}

function ExcludedRow({ lead: l, excludedNow, onTick }: { lead: SpiderExcludedLead; excludedNow: boolean; onTick: (exclude: boolean) => void }) {
  const time = timeInStage(l.stage_entered_at);
  return (
    <div data-spider-excluded-lead={l.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface-light px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-bold text-text-primary">
          <span className="font-mono">{l.lead_number}</span> · {l.customer_name}
        </p>
        <p className="truncate text-[11.5px] text-text-soft">{[statusLabel(l.status), time].filter(Boolean).join(' · ')}</p>
      </div>
      {excludedNow ? (
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => onTick(false)}>
          <Undo2 aria-hidden className="h-3.5 w-3.5" />
          Include again
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => onTick(true)}>
          Exclude
        </Button>
      )}
    </div>
  );
}
