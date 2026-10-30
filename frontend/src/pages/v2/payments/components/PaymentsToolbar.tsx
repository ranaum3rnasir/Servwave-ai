import { Download } from 'lucide-react';

import { paymentsRegistry } from '@/lib/filters/registries/payments';
import type { FacetOption, FilterState } from '@/lib/filters/types';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { SelectField } from '@/ui-kit/components/form/selectField';

import type { AttentionView } from '@/lib/api/paymentsPage';

import { FilterPopover } from '../../_shared/filterPopover';
import { PHONE_TAP_AREA } from '../phoneTap';

/** The quick chips, in order. The value is the API's `chip` param; All sends none. */
export const PAYMENT_CHIPS = [
  { value: 'all', label: 'All' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'pending', label: 'Pending' },
  { value: 'failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'attention', label: 'Needs attention' },
] as const;
export type PaymentChip = (typeof PAYMENT_CHIPS)[number]['value'];

const NO_OPTIONS = (): FacetOption[] => [];
/** The Amount facet's slider ceiling: well above a realistic single payment. */
const resolveMax = () => 100000;

/** What the Needs attention view adds to the toolbar: the Open/Resolved switch, the type, and the counts. */
export interface AttentionToolbar {
  view: AttentionView;
  onView: (view: AttentionView) => void;
  openCount: number;
  resolvedCount: number;
  /** One of ATTENTION_TYPE_OPTIONS' values; 'all' for none. */
  type: string;
  onType: (type: string) => void;
}

/** The type select's choices. "Unmatched money" is two item types to the server. */
export const ATTENTION_TYPE_OPTIONS = [
  { value: 'all', label: 'All types' },
  { value: 'failed_payment', label: 'Failed payments' },
  { value: 'failed_refund', label: 'Failed refunds' },
  { value: 'dispute', label: 'Disputes' },
  { value: 'failed_payout', label: 'Failed payouts' },
  { value: 'unmatched', label: 'Unmatched money' },
];

/**
 * The Payments tab's controls, one block: the quick chips, then the search box filling the row, the app's own Filter
 * popover and Export.
 */
export function PaymentsToolbar({
  chip, onChip, disputedCount, attentionCount, attention, searchValue, onSearchValue, onSearchSettled, filters, onFilters, onExport, exporting,
}: {
  chip: PaymentChip;
  onChip: (chip: PaymentChip) => void;
  disputedCount: number;
  /** Open items; the Needs attention chip wears it. */
  attentionCount: number;
  /** Present while the Needs attention chip is on. */
  attention?: AttentionToolbar;
  searchValue: string;
  onSearchValue: (value: string) => void;
  onSearchSettled: (value: string) => void;
  filters: FilterState;
  onFilters: (next: FilterState) => void;
  onExport: () => void;
  exporting: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Quick filters" className="flex flex-wrap gap-2">
        {PAYMENT_CHIPS.map((c) => (
          <Button
            key={c.value}
            type="button"
            size="sm"
            variant={chip === c.value ? 'default' : 'outline'}
            aria-pressed={chip === c.value}
            onClick={() => onChip(c.value)}
          >
            {c.label}
            {c.value === 'disputed' && disputedCount > 0 && (
              <>
                {' '}
                <Badge variant="softRed" size="pill">{disputedCount}</Badge>
              </>
            )}
            {c.value === 'attention' && attentionCount > 0 && (
              <>
                {' '}
                <Badge variant="softRed" size="pill">{attentionCount}</Badge>
              </>
            )}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div data-slot="payments-search" className="min-w-[min(16rem,100%)] flex-1">
          <SearchInput
            value={searchValue}
            onValueChange={onSearchValue}
            onDebouncedChange={onSearchSettled}
            placeholder="Search customer, invoice or payment"
            aria-label="Search customer, invoice or payment"
          />
        </div>
        {attention ? (
          <>
            <div className="w-44 max-sm:w-full">
              <SelectField
                aria-label="Type"
                value={attention.type}
                onValueChange={attention.onType}
                options={ATTENTION_TYPE_OPTIONS}
                className="max-sm:min-h-11"
              />
            </div>
            <div role="group" aria-label="Item status" className="flex gap-2">
              <Button
                type="button" size="sm" className="max-sm:min-h-11" aria-pressed={attention.view === 'open'}
                variant={attention.view === 'open' ? 'default' : 'outline'} onClick={() => attention.onView('open')}
              >
                Open ({attention.openCount})
              </Button>
              <Button
                type="button" size="sm" className="max-sm:min-h-11" aria-pressed={attention.view === 'resolved'}
                variant={attention.view === 'resolved' ? 'default' : 'outline'} onClick={() => attention.onView('resolved')}
              >
                Resolved ({attention.resolvedCount})
              </Button>
            </div>
          </>
        ) : (
          <>
            <FilterPopover
              registry={paymentsRegistry}
              value={filters}
              onChange={onFilters}
              resolveOptions={NO_OPTIONS}
              resolveMax={resolveMax}
              sheetClassName={PHONE_TAP_AREA}
            />
            <Button type="button" variant="outline" size="sm" onClick={onExport} disabled={exporting}>
              <Download />
              Export
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
