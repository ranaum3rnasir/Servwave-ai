import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileText, Plus, UserPlus } from 'lucide-react';

import api from '@/lib/axios';
import { useFeature } from '@/lib/entitlements';
import { formatPhone } from '@/lib/utils';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Separator } from '@/ui-kit/components/ui/separator';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { useDebounce } from '@/ui-kit/hooks/useDebounce';

import { preferV2Path, v2Path } from '../../uiV2';

/**
 * v2 "Create New Estimate" picker - the kit rebuild of
 * `components/estimates/NewEstimateDialog`.
 *
 * REBUILT rather than imported: the original is one of the pages this design
 * replaced, so importing it would pull the old presentation back in. Its
 * destinations (`/estimates/new?lead_id=`, `/leads/new`) are unchanged and now
 * resolve to the rebuilt pages directly; the `v2Path` / `preferV2Path` wrappers
 * around them are no-op shims (see `uiV2.ts`).
 *
 * Everything else is the original's, verbatim: the same three queries and query
 * keys, the same 300 ms debounce and 2-character minimum, the same five body
 * branches in the same order, the same copy, and the same client-side
 * ACTIVE_STATUSES allowlist.
 */

interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  phone: string;
  email: string | null;
}

interface Lead {
  id: string;
  status: string;
  service_request: string;
  created_at: string;
}

/**
 * Non-terminal lead statuses - the exact set the server's estimate-create gate
 * accepts (it rejects only WON/LOST/CANCELLED). LOAD-BEARING: GET /api/leads
 * here passes no status param, so the API returns terminal leads too and this
 * filter is the only thing keeping them out of the picker. A lead with a
 * walkthrough booked or done is still open, so both walkthrough statuses are in.
 */
const ACTIVE_STATUSES = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'];

export interface NewEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preSelectedCustomerId?: string;
  onPreSelectConsumed?: () => void;
}

/**
 * The dialog's own display-name rule, kept byte-for-byte rather than swapped
 * for `lib/customer-name`. The two differ (this one omits the company when the
 * person's name is empty in a different way), and the list column and this
 * picker have always disagreed; aligning them is a copy change, not a restyle.
 */
function customerDisplayName(c: Customer) {
  const first = c.first_name?.trim();
  const last = c.last_name?.trim();
  const name = last && first ? `${first} ${last}` : (last || first || '');
  return c.company_name ? (name ? `${name} (${c.company_name})` : c.company_name) : name;
}

/**
 * Lead status inside the picker, NEUTRAL by design.
 *
 * The legacy dialog passes `neutral` to StatusBadge here: these rows are a
 * choice list, not a status column, and a row of coloured lifecycle badges
 * competes with the description that is actually being chosen between. The
 * label still comes from the registry, so it never drifts from the leads list.
 */
function LeadStatusPill({ status }: { status: string }) {
  const label = STATUS_REGISTRY.lead[status]?.label ?? status;
  return <Badge variant="softNeutral" size="sm">{label}</Badge>;
}

/**
 * The leads panel under an expanded customer. One component instead of the
 * original's two copies of the same markup - the legacy file duplicates it
 * for the pre-selected branch and the search branch, which is how the two
 * drifted apart in the first place.
 *
 * Declared at module scope, NOT inside the dialog: a component declared during
 * render is a brand-new component type on every render, so React unmounts and
 * remounts this whole subtree each time the parent re-renders (which the 300 ms
 * search debounce does on every keystroke). Everything it used to close over is
 * a prop now.
 */
function LeadsPanel({
  customerId, leadsLoading, actionableLeads, onLeadSelect, onCreateLead, onCreateEstimateNoLead,
}: {
  customerId: string;
  leadsLoading: boolean;
  actionableLeads: Lead[];
  onLeadSelect: (leadId: string) => void;
  onCreateLead: (customerId: string) => void;
  onCreateEstimateNoLead: (customerId: string) => void;
}) {
  if (leadsLoading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Spinner />
      </div>
    );
  }

  // #2027 — the footer is UNCONDITIONAL. Both creation paths are always offered: pick a lead,
  // start a lead, or go straight to an estimate on the customer. "Create estimate without a lead"
  // used to render only in the no-leads branch, so a customer with one open lead could be reached
  // only through that lead — even though the direct path exists end to end and the handler below
  // already navigates correctly. The list above is the only part that varies.
  return (
    <div className="flex flex-col">
      {actionableLeads.length === 0 ? (
        <p className="text-muted-foreground px-3 py-3 text-xs">No active leads</p>
      ) : (
        actionableLeads.map((lead) => (
          <Button
            key={lead.id}
            variant="ghost"
            size="sm"
            className="h-auto justify-between gap-2 px-3 py-2.5 text-left font-normal"
            onClick={() => onLeadSelect(lead.id)}
          >
            <span className="min-w-0 flex-1 truncate text-xs">
              {lead.service_request || 'No description'}
            </span>
            <LeadStatusPill status={lead.status} />
          </Button>
        ))
      )}
      {/* Separates the footer from the lead list, so the two unconditional rows below never read
          as one more lead. */}
      <Separator />
      <div className="flex flex-col items-start gap-1 px-3 py-2">
        {/* Offered even without the `leads` entitlement, exactly as the legacy dialog does. The
            lead form owns that gate; hiding the link here would be a new restriction. */}
        <Button variant="link" size="sm" className="px-0" onClick={() => onCreateLead(customerId)}>
          <Plus />
          Create new lead
        </Button>
        <Button variant="link" size="sm" className="px-0" onClick={() => onCreateEstimateNoLead(customerId)}>
          <FileText />
          Create estimate without a lead
        </Button>
      </div>
    </div>
  );
}

function NewEstimateDialog({
  open, onOpenChange, preSelectedCustomerId, onPreSelectConsumed,
}: NewEstimateDialogProps) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(null);
  const debouncedSearch = useDebounce(search, 300);

  // Reset when the dialog closes, so reopening never shows the last search.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate reset-on-close idiom, guarded by `!open` so it runs once per close
      setSearch('');
      setExpandedCustomerId(null);
    }
  }, [open]);

  useEffect(() => {
    if (open && preSelectedCustomerId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the expanded row from a prop the parent sets on open, then reports it consumed
      setExpandedCustomerId(preSelectedCustomerId);
      onPreSelectConsumed?.();
    }
  }, [open, preSelectedCustomerId, onPreSelectConsumed]);

  const { data: customers, isLoading: customersLoading } = useQuery({
    queryKey: ['customers-picker', debouncedSearch],
    queryFn: async () => {
      // #2041 slice 1 - the org-wide create-form picker (Ran's carve-out): a rep must be able
      // to start an estimate on a customer they have never worked with.
      const { data } = await api.get('/api/customers/picker', {
        params: { search: debouncedSearch, limit: 6 },
      });
      return data.customers as Customer[];
    },
    enabled: debouncedSearch.length >= 2,
  });

  const { data: preSelectedCustomer } = useQuery({
    queryKey: ['customer-picker', expandedCustomerId],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/picker/${expandedCustomerId}`);
      return data.customer as Customer;
    },
    enabled: Boolean(expandedCustomerId) && debouncedSearch.length < 2,
  });

  // Skipped without the Pro `leads` entitlement: /api/leads 402s there, and
  // estimates have been customer-anchorable since R6 - a lead is one possible
  // anchor, never a prerequisite for the Starter-core estimate flow.
  const hasLeads = useFeature('leads');
  const { data: leadsData, isLoading: leadsLoading } = useQuery({
    queryKey: ['leads', { customer_id: expandedCustomerId }],
    queryFn: async () => {
      const { data } = await api.get('/api/leads', {
        params: { customer_id: expandedCustomerId, limit: 10 },
      });
      return data.leads as Lead[];
    },
    enabled: Boolean(expandedCustomerId) && hasLeads,
  });

  const actionableLeads = leadsData?.filter((l) => ACTIVE_STATUSES.includes(l.status)) ?? [];

  function handleCustomerClick(customerId: string) {
    setExpandedCustomerId(expandedCustomerId === customerId ? null : customerId);
  }

  function handleLeadSelect(leadId: string) {
    onOpenChange(false);
    navigate(v2Path(`/estimates/new?lead_id=${leadId}`));
  }

  function handleAddNewClient() {
    onOpenChange(false);
    // `returnTo` stays a v2 path so the customer form comes back into this layer.
    navigate(preferV2Path('/customers/new'), { state: { returnTo: v2Path('/estimates') } });
  }

  function handleCreateLead(customerId: string) {
    onOpenChange(false);
    navigate(preferV2Path(`/leads/new?customer_id=${customerId}`));
  }

  function handleCreateEstimateNoLead(customerId: string) {
    onOpenChange(false);
    navigate(v2Path(`/estimates/new?customer_id=${customerId}`));
  }

  // The props every `LeadsPanel` on this screen shares; only `customerId`
  // differs between the two call sites.
  const leadsPanelProps = {
    leadsLoading,
    actionableLeads,
    onLeadSelect: handleLeadSelect,
    onCreateLead: handleCreateLead,
    onCreateEstimateNoLead: handleCreateEstimateNoLead,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon>
            <FileText />
          </DialogIcon>
          <div className="min-w-0">
            <DialogTitle>Create New Estimate</DialogTitle>
            <DialogDescription>Select a client to get started</DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody>
          <SearchInput
            value={search}
            onValueChange={setSearch}
            placeholder="Name, email, phone, or company..."
            autoFocus
          />

          <div className="mt-3 max-h-[320px] min-h-[120px] overflow-y-auto">
            {expandedCustomerId && debouncedSearch.length < 2 && preSelectedCustomer ? (
              /* Pre-selected customer: shown directly, without a search. */
              <div>
                <div className="flex items-center gap-3 px-2 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {customerDisplayName(preSelectedCustomer)}
                    </p>
                    <p className="text-muted-foreground text-xs">{formatPhone(preSelectedCustomer.phone)}</p>
                  </div>
                  <ChevronDown className="text-muted-foreground size-4 shrink-0" />
                </div>
                <div className="bg-muted mb-3 ml-2 rounded-lg border">
                  <LeadsPanel customerId={preSelectedCustomer.id} {...leadsPanelProps} />
                </div>
              </div>
            ) : debouncedSearch.length < 2 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                Type at least 2 characters to search
              </p>
            ) : customersLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner />
              </div>
            ) : !customers?.length ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                No clients found
              </p>
            ) : (
              <div className="flex flex-col">
                {customers.map((customer) => {
                  const isExpanded = expandedCustomerId === customer.id;
                  return (
                    <div key={customer.id}>
                      <Button
                        variant="ghost"
                        className="h-auto w-full justify-between gap-3 px-2 py-3 text-left font-normal"
                        onClick={() => handleCustomerClick(customer.id)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {customerDisplayName(customer)}
                          </span>
                          <span className="text-muted-foreground block text-xs">
                            {formatPhone(customer.phone)}
                          </span>
                        </span>
                        {isExpanded ? <ChevronDown /> : <ChevronRight />}
                      </Button>

                      {isExpanded && (
                        <div className="bg-muted mb-3 ml-2 rounded-lg border">
                          <LeadsPanel customerId={customer.id} {...leadsPanelProps} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 pt-2 pb-5">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-xs">OR</span>
            <Separator className="flex-1" />
          </div>
          <div className="flex justify-center pb-5">
            <Button variant="link" onClick={handleAddNewClient}>
              <UserPlus />
              Add new client
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export { NewEstimateDialog };
