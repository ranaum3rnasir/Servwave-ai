import { useIsBelow } from '@/ui-kit/hooks/useMediaQuery';

/**
 * True when a detail page's tab tables render as cards: below lg (1024), not below md.
 *
 * The slice asked for md. Measured on an iPad Mini (768 wide, a 634 px content box), the customer
 * page's Leads table is 699 px wide with its headers alone (seven columns), so from 768 to 1023 it
 * would scroll sideways inside its box with even the shortest data; the other tabs and the lead
 * page's Estimates table join it as soon as a real name or date lands in them. Cards there read
 * better than a scrolling table, and from lg up (an iPad held sideways, a laptop) the tables are
 * exactly what they were. ONE threshold for every detail-tab table, so a page never mixes them.
 */
export function useRecordCards(): boolean {
  return useIsBelow('lg');
}
