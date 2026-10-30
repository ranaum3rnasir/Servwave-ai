import { Download } from 'lucide-react';

import { paymentsRegistry } from '@/lib/filters/registries/payments';
import type { FacetOption, FilterState } from '@/lib/filters/types';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { SearchInput } from '@/ui-kit/components/form/searchInput';

import type { AttentionView } from '@/lib/api/paymentsPage';

import { FilterPopover } from '../../_shared/filterPopover';
import { Segment, SegmentedGroup } from '../../_shared/segmented';
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

/** What the Needs attention view adds to the toolbar: the Open/Resolved switch and its counts. */
export interface AttentionToolbar {
  view: AttentionView;
  onView: (view: AttentionView) => void;
  openCount: number;
  resolvedCount: number;
}

/** The chip row scrolls sideways on purpose (V7 C-24); the gate's exemption list names it. */
const CHIP_ROW = {
  'data-mobile-scroll-x': 'payments-quick-filters',
} as const;

/**
 * The Payments tab's controls, one block: the quick chips (one row that scrolls sideways), then the search box filling
 * the row, the app's own Filter popover and Export; on the Needs attention chip, the Open/Resolved switch instead.
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
      <div
        role="group"
        aria-label="Quick filters"
        {...CHIP_ROW}
        className="-m-0.5 flex min-w-0 flex-nowrap gap-2 overflow-x-auto overscroll-x-contain p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {PAYMENT_CHIPS.map((c) => (
          <Button
            key={c.value}
            type="button"
            size="sm"
            className="h-9 shrink-0 rounded-full px-3.5 max-sm:h-11"
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
        <div data-slot="payments-search" className="min-w-0 flex-1 basis-64 max-sm:basis-0">
          <SearchInput
            value={searchValue}
            onValueChange={onSearchValue}
            onDebouncedChange={onSearchSettled}
            placeholder="Search customer, invoice or payment"
            aria-label="Search customer, invoice or payment"
          />
        </div>
        {attention ? (
          <SegmentedGroup aria-label="Item status" className="max-sm:basis-full">
            <Segment
              active={attention.view === 'open'} className="h-8 max-sm:h-11 max-sm:flex-1" onClick={() => attention.onView('open')}
            >
              Open ({attention.openCount})
            </Segment>
            <Segment
              active={attention.view === 'resolved'} className="h-8 max-sm:h-11 max-sm:flex-1" onClick={() => attention.onView('resolved')}
            >
              Resolved ({attention.resolvedCount})
            </Segment>
          </SegmentedGroup>
        ) : (
          <>
            <FilterPopover
              registry={paymentsRegistry}
              value={filters}
              onChange={onFilters}
              resolveOptions={NO_OPTIONS}
              resolveMax={resolveMax}
              sheetClassName={PHONE_TAP_AREA}
              triggerClassName="h-10 max-sm:h-11"
            />
            <Button
              type="button" variant="outline" size="sm" className="h-10 max-sm:h-11 max-sm:basis-full" onClick={onExport} disabled={exporting}
            >
              <Download />
              Export
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
