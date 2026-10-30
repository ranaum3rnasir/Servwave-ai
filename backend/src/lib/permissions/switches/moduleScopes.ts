/**
 * The scope switch of a module that is not a record anchor (Roles & Permissions P6, A8a): Tasks, Events, Stock (assets),
 * Time tracking and Communication each have ONE scope switch, with the standard choices (Attached, Team, All), and it
 * governs every verb of that module. The record anchors (Leads, Jobs, Estimates, Invoices) keep `SCOPE_SWITCH_KEY` in
 * the catalog. The key is the module whose row carries the scope dropdown on the Roles page and a person's page.
 */
export const MODULE_SCOPE_KEY = {
  Tasks: 'tasks_scope',
  Events: 'events_scope',
  Stock: 'assets_scope',
  'Time tracking': 'timesheets_scope',
  Communication: 'communication_scope',
} as const;

export type ScopedModule = keyof typeof MODULE_SCOPE_KEY;
