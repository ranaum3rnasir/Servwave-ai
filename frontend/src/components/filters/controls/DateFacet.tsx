import { DateRangeField } from '@/components/form/DateRangeField';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import type { FacetControlProps } from './facetControlProps';

/**
 * Pane control for `kind: 'dateRange'` facets: a thin wrapper around the
 * existing `DateRangeField` (presets + custom range), mapping between its
 * plain `{from, to}` strings and the facet's `{kind:'dateRange', from, to}`
 * `FilterValue`.
 *
 * #1634: `DateFacet` renders EVERY dateRange facet a registry declares -
 * "created" (a "when was this row made" fact, viewer-local by design) and
 * "scheduled" (a real scheduling fact, an org fact) alike. Only the latter
 * gets the org zone; every other facet key keeps the pre-existing
 * browser-clock behaviour by getting `tz={undefined}`. `useScheduleTimezone`
 * is called unconditionally (rules of hooks) - only its USE is conditional.
 */
export function DateFacet({ facet, value, onChange }: FacetControlProps) {
  const from = value?.kind === 'dateRange' ? value.from : '';
  const to = value?.kind === 'dateRange' ? value.to : '';
  const orgTz = useScheduleTimezone();
  const tz = facet.key === 'scheduled' ? orgTz : undefined;

  return (
    <DateRangeField
      label={facet.label}
      from={from}
      to={to}
      tz={tz}
      onChange={(next) => onChange({ kind: 'dateRange', from: next.from, to: next.to })}
    />
  );
}
