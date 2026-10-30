import { SCOPE_SWITCH_KEY, type ScopedSubject, type SwitchEntry } from './catalog';

/**
 * Where each switch sits on the Roles page and a person's Permissions page (Roles & Permissions, PRD 2, M12).
 *
 * The catalog says what a switch is and the screens say nothing of their own: both draw from this layout, which is
 * read from the catalog beside the switches. A switch's module is its catalog `module`; the group headings, their
 * order and the row's first line (View, Create, Edit, Delete, Show, Export) are fixed here; a switch that narrows
 * another (it Requires it) is nested under it.
 */

/** The groups a screen draws, in order, each over the catalog modules it holds. A heading carries no switch. */
const GROUPS: ReadonlyArray<{ label: string; modules: readonly string[] }> = [
  { label: 'Customers', modules: ['Customers'] },
  { label: 'Leads', modules: ['Leads'] },
  { label: 'Estimates', modules: ['Estimates'] },
  { label: 'Jobs and visits', modules: ['Jobs'] },
  { label: 'Invoices and payments', modules: ['Invoices'] },
  { label: 'Attachments', modules: ['Attachments'] },
  { label: 'Notes', modules: ['Notes'] },
  { label: 'Tasks and events', modules: ['Tasks', 'Events'] },
  { label: 'Inventory', modules: ['Stock', 'Purchase Orders', 'Vendors', 'Logistic Orders', 'Price Book'] },
  { label: 'Service Plans and Automations', modules: ['Service Plans', 'Automations'] },
  { label: 'Communication', modules: ['Communication'] },
  { label: 'Team and settings', modules: ['Users', 'Departments', 'Locations', 'Settings'] },
  { label: 'Time tracking', modules: ['Time tracking'] },
  { label: 'Pages', modules: ['Pages'] },
];

/** The module whose records each scope choice narrows; the choice sits on that module's row. */
const SCOPE_ROW: Record<ScopedSubject, string> = { Lead: 'Leads', Job: 'Jobs', Estimate: 'Estimates', Invoice: 'Invoices' };

const DATA_SCOPE = 'Data Scope';

/** What a module row says in place of a scope control when its records are reached through leads and jobs (M3). */
const FOLLOWS_RECORDS_NOTE = 'Follows the leads and jobs this person can open.';

export interface LayoutExtra {
  key: string;
  /** The switch this one narrows: a line of the row or another extra of it. Null when it stands on the row. */
  parent: string | null;
}

export interface LayoutModule {
  /** The catalog module the row draws. */
  module: string;
  label: string;
  /** The row's first line, in order: View, Create, Edit, Delete, Show, Export, only those the module has. */
  lines: string[];
  /** The Data Scope choice of the records this row covers, when it has one. */
  scope: string | null;
  /** The line a row with no scope of its own carries: its records are reached through the leads and jobs the person can open. */
  scopeNote: string | null;
  /** Every other switch of the module, in catalog order. */
  extras: LayoutExtra[];
}

export interface LayoutGroup {
  label: string;
  modules: LayoutModule[];
}

export interface CatalogLayout {
  /** The money lines at the top of the screen, See financial data last. */
  dataScope: string[];
  groups: LayoutGroup[];
}

/** How a switch of a module with a View is recognised as one of the row's first-line switches. */
const LINE_RULES: ReadonlyArray<(s: SwitchEntry, view: SwitchEntry) => boolean> = [
  (s, view) => s.key === view.key,
  (s) => /^(create|upload)_/.test(s.key),
  (s) => s.key.startsWith('edit_'),
  (s) => s.key.startsWith('delete_'),
  (s) => /^show_.+_page$/.test(s.key),
  (s) => s.key.startsWith('export_'),
];

/** The row's first line: for each rule, the first switch of the module that matches and Requires only the View. */
function rowLines(switches: SwitchEntry[]): string[] {
  // A View is the row's only when the rest of the row needs it ("View payments and payouts" in Settings stands alone).
  const view = switches.find(
    (s) => s.key.startsWith('view_') && s.requires.length === 0 && switches.some((o) => o.requires.includes(s.key)),
  );
  if (!view) return [];
  const lines: string[] = [];
  for (const rule of LINE_RULES) {
    const match = switches.find(
      (s) => !lines.includes(s.key) && rule(s, view) && (s.key === view.key || (s.requires.length === 1 && s.requires[0] === view.key && !s.requiresAny)),
    );
    if (match) lines.push(match.key);
  }
  return lines;
}

function buildModule(module: string, switches: SwitchEntry[], scope: string | null): LayoutModule {
  const lines = rowLines(switches);
  const view = lines.find((k) => k.startsWith('view_')) ?? null;
  const keys = new Set(switches.map((s) => s.key));
  const extras = switches
    .filter((s) => !lines.includes(s.key))
    .map((s): LayoutExtra => {
      // The last switch it Requires from its own row, other than the row's View, is the one it narrows.
      const narrowed = s.requires.filter((r) => r !== view && keys.has(r) && r !== s.key);
      return { key: s.key, parent: narrowed.length ? narrowed[narrowed.length - 1]! : null };
    });
  // A module whose grants are scoped to a customer, purchase order or logistic order has no Data Scope choice of its own.
  const reachedThroughRecords = switches.some((s) =>
    s.grants.some((g) => g.scoped === 'Customer' || g.scoped === 'PurchaseOrder' || g.scoped === 'LogisticOrder' || g.scoped === 'LogisticOrderOnJob'),
  );
  return { module, label: module, lines, scope, scopeNote: reachedThroughRecords && !scope ? FOLLOWS_RECORDS_NOTE : null, extras };
}

export function buildCatalogLayout(catalog: readonly SwitchEntry[]): CatalogLayout {
  const scopeKeys = new Set<string>(Object.values(SCOPE_SWITCH_KEY));
  const dataScope = catalog.filter((s) => s.module === DATA_SCOPE && !scopeKeys.has(s.key)).map((s) => s.key);

  const scopeOf = new Map<string, string>(
    (Object.keys(SCOPE_SWITCH_KEY) as ScopedSubject[]).map((subject) => [SCOPE_ROW[subject], SCOPE_SWITCH_KEY[subject]]),
  );
  const modulesInCatalog: string[] = [];
  for (const s of catalog) {
    if (s.module !== DATA_SCOPE && !modulesInCatalog.includes(s.module)) modulesInCatalog.push(s.module);
  }
  const placed = new Set(GROUPS.flatMap((g) => g.modules));
  // A module the groups above do not name still gets a row, in a group of its own after the others.
  const groups = [...GROUPS, ...modulesInCatalog.filter((m) => !placed.has(m)).map((m) => ({ label: m, modules: [m] }))];

  return {
    dataScope,
    groups: groups
      .map((g) => ({
        label: g.label,
        modules: g.modules
          .filter((m) => modulesInCatalog.includes(m))
          .map((m) =>
            buildModule(m, catalog.filter((s) => s.module === m && !scopeKeys.has(s.key)), scopeOf.get(m) ?? null),
          ),
      }))
      .filter((g) => g.modules.length > 0),
  };
}
