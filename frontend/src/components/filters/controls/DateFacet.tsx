import { DateField } from '@/ui-kit/components/form/dateField';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import type { FacetControlProps } from './facetControlProps';

/**
 * Pane control for `kind: 'dateRange'` facets: a thin wrapper around
 * `DateField` (mode="range" - presets + custom range), mapping between its
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
    <DateField
      mode="range"
      value={{ from, to }}
      tz={tz}
      onChange={(next) => onChange({ kind: 'dateRange', from: next.from, to: next.to })}
      aria-label={facet.label ? `${facet.label} range` : 'Date range'}
    />
  );
}
