import { AD_SOURCES } from '@/lib/filters/registries/customers';

/**
 * Ad source, sentence-cased for DISPLAY only.
 *
 * The stored value is never rewritten - the row, the filter param and every
 * request keep whatever the org typed into its own source list, which in
 * practice is shouted (`REFERRAL`, `WEBSITE`). `AD_SOURCES` is the app's
 * existing source list and already carries the canonical casing, so it IS the
 * map rather than a second hardcoded one; a source outside it (org-defined,
 * e.g. `WEBSITE`) falls through to the same title-casing rule instead of
 * needing its own entry.
 *
 * Shared because both the leads and the customers column sets print an ad
 * source, and both must print it the same way. It lived in
 * `pages/v2/leads/leadsColumns.tsx` and customers imported it from there, which
 * made a leads column file a dependency of the customers list.
 */
const AD_SOURCE_LABELS = new Map(AD_SOURCES.map((source) => [source.toUpperCase(), source]));

export function adSourceLabel(value: string): string {
  return (
    AD_SOURCE_LABELS.get(value.toUpperCase()) ??
    value
      .replace(/[_-]+/g, ' ')
      .replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
  );
}
