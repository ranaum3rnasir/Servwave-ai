/**
 * The taggable-entity map — the single source of truth for every consumer that
 * has to enumerate the entity types a tag can be attached to.
 *
 * Tagging spans five entity types (SRVW-103). Two surfaces have to know that
 * set: TagInput, which writes a tag onto one record and refetches that record's
 * detail query, and TagsSettingsCard, which renames, recolours or deletes a tag
 * org-wide and so has to drop every cached payload carrying a copy of it.
 *
 * They drifted once already: TagInput was widened from two types to five while
 * the settings card kept its hand-written two-type list, so deleting a tag left
 * its chip on any cached customer, estimate or invoice page until a hard
 * reload. Extracting the map is the same anti-drift move TAG_COLORS made in
 * `tag-colors.ts` — a sixth entity type added here reaches both consumers for
 * free, instead of being remembered in one place and forgotten in the other.
 */

export type TagEntityType = 'CUSTOMER' | 'LEAD' | 'ESTIMATE' | 'JOB' | 'INVOICE';

export interface TagEntityRoute {
  /** REST segment for the per-record tag write: `/api/{path}/:id/tags`. */
  path: string;
  /** Detail query key prefix the host record page reads. */
  detailKey: string;
  /** List query key prefix — every list page renders a Tags column (TagChips). */
  listKey: string;
}

export const TAG_ENTITY_ROUTES: Record<TagEntityType, TagEntityRoute> = {
  CUSTOMER: { path: 'customers', detailKey: 'customer', listKey: 'customers' },
  LEAD: { path: 'leads', detailKey: 'lead', listKey: 'leads' },
  ESTIMATE: { path: 'estimates', detailKey: 'estimate', listKey: 'estimates' },
  JOB: { path: 'jobs', detailKey: 'job', listKey: 'jobs' },
  INVOICE: { path: 'invoices', detailKey: 'invoice', listKey: 'invoices' },
};

/**
 * The schedule board's own keys. `useScheduleData` fetches `/api/jobs` and
 * `/api/leads` — the very list endpoints that attach tags — but caches them
 * under these four keys rather than under `['jobs']`/`['leads']`, and
 * ScheduleCardBody/UnassignedBuckets render `<TagChips tags={event.tags} />`
 * from those payloads. So the board carries the identical staleness and is not
 * reachable by invalidating the list keys above.
 */
export const TAG_BOARD_QUERY_KEYS = [
  'schedule-jobs',
  'schedule-walkthroughs',
  'schedule-unassigned',
  'schedule-unscheduled-walkthroughs',
] as const;

/**
 * Every query key prefix whose cached payload embeds a copy of a tag row.
 *
 * Deliberately enumerated rather than blanket-invalidating the whole cache: a
 * tag edit is rare, but dropping every query in the app on one would refetch
 * dashboards, reports and settings that never render a tag.
 */
export const TAG_EMBEDDING_QUERY_KEYS: readonly string[] = [
  ...Object.values(TAG_ENTITY_ROUTES).flatMap((route) => [route.detailKey, route.listKey]),
  ...TAG_BOARD_QUERY_KEYS,
];
