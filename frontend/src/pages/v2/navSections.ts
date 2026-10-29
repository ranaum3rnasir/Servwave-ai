/**
 * Sections for the v2 sidebar.
 *
 * The nav registry is a FLAT list - the legacy sidebar renders it as one column
 * of shortcuts - but the kit's shell groups destinations under headings, and the
 * first heading shares its row with the collapse control. So the grouping lives
 * here, keyed by registry key, rather than being invented in the registry (which
 * the legacy sidebar also reads and which this branch must not touch).
 *
 * Order inside a section still comes from the user's own layout, so a reorder
 * made in the legacy sidebar is honoured. A key the user has pinned that no
 * section claims falls into the last one, so nothing can silently disappear.
 */
export const NAV_SECTIONS: { section: string; keys: readonly string[] }[] = [
  { section: 'Workspace', keys: ['dashboard', 'schedule', 'tasks', 'leads', 'jobs', 'clients'] },
  { section: 'Billing', keys: ['estimates', 'invoices', 'service-plans'] },
  {
    section: 'Operations',
    keys: ['automations', 'pricebook', 'billing', 'reports', 'inventory', 'communication', 'marketing'],
  },
];

/**
 * The heading a destination sits under, or undefined when no section claims it.
 * The sidebar itself buckets unclaimed keys into the last section, so it does
 * not need this; it is here for anything that has to name a key's section
 * without rebuilding the whole row list.
 */
export function sectionForKey(key: string): string | undefined {
  return NAV_SECTIONS.find((section) => section.keys.includes(key))?.section;
}
