import { isDeepStrictEqual } from 'util';
import { SWITCH_CATALOG, sameSwitchValue, type SwitchEntry, type SwitchValue } from './catalog';
import { renamedSwitchKey } from './presetMigrationRenames';
import { loadPresetMigrationSnapshot, parsePresetMigrationSql, type PresetMigrationSnapshot } from './presetMigrationSnapshot';

/**
 * Is the applied preset migration still the whole story? (Roles & Permissions, slice S01.22)
 *
 * Migration 20261012120000 has run on staging, so its file is frozen: the snapshot holds what it wrote, and a test
 * ties the snapshot to the SQL. Two things can still be wrong, and they are told apart here:
 *
 *  - the FILE was edited after it ran (it no longer says what the snapshot froze): put it back, never rewrite it;
 *  - the CATALOG moved on: a switch the migration wrote now has another preset, another kind, or is gone. Stored
 *    rows still hold the old preset, so a FOLLOW-UP migration has to move them. A switch added later is fine (a role
 *    with no stored row resolves to the catalog preset), and so is a changed grant mapping: the mapping is read once,
 *    to translate the custom roles that existed when the migration ran.
 */
/**
 * A preset value that a LATER migration (written after the applied preset migration, as its drift report asks) moved on
 * stored rows. The catalog holds `now`; the applied migration still writes `was`; the follow-up carries the stored rows from
 * one to the other, so the catalog having moved is no longer drift. Add an entry here in the same change as the follow-up
 * migration that does the move, and list ONLY moves that migration really makes.
 */
export interface PresetFollowUpMove {
  role: string;
  key: string;
  was: SwitchValue;
  now: SwitchValue;
}
export const PRESET_FOLLOW_UPS: ReadonlyArray<{ migration: string; moves: readonly PresetFollowUpMove[]; retired?: readonly string[] }> = [
  {
    // M8: the built-in rows that still equal the old preset take the new one (Create requires Edit; Technician and Dispatcher).
    migration: '20261028100300_permission_create_requires_edit',
    moves: [
      { role: 'TECHNICIAN', key: 'edit_leads', was: false, now: true },
      { role: 'TECHNICIAN', key: 'edit_estimates', was: false, now: true },
      { role: 'TECHNICIAN', key: 'edit_jobs', was: false, now: true },
      { role: 'TECHNICIAN', key: 'record_payments', was: true, now: false },
      { role: 'TECHNICIAN', key: 'send_payment_links', was: true, now: false },
      { role: 'DISPATCHER', key: 'edit_customers', was: false, now: true },
      { role: 'DISPATCHER', key: 'edit_estimates', was: false, now: true },
    ],
  },
  {
    // M9a (AL-08): the four See-all toggles became each module's scope switch (the stored rows are renamed and their
    // value mapped), and Communication scope's "Linked to me" became Attached. `retired` lists the keys that migration
    // removed from the catalog; the scope switches that replace them are new keys, so they carry no move.
    migration: '20261028100500_permission_reach_toggles_become_scope',
    retired: ['see_all_tasks', 'see_all_calendar_entries', 'see_all_assets', 'see_everyones_timesheets'],
    moves: [
      { role: 'SALES', key: 'communication_scope', was: 'linked_to_me', now: 'attached' },
      { role: 'DISPATCHER', key: 'communication_scope', was: 'linked_to_me', now: 'attached' },
      { role: 'TECHNICIAN', key: 'communication_scope', was: 'linked_to_me', now: 'attached' },
    ],
  },
  {
    // M5 (AL-07): uploads and notes are the record's own data, so the four attachment switches and Delete other people's
    // notes are gone and their stored rows deleted. The record's View and Edit decide, with no preset to carry.
    migration: '20261028100600_permission_attachments_notes_with_record',
    retired: ['view_attachments', 'upload_attachments', 'edit_attachments', 'delete_attachments', 'delete_others_notes'],
    moves: [],
  },
  {
    // M6 (AL-06b): estimates and invoices follow the Jobs and Leads scope, so their two scope switches are gone and their stored
    // rows deleted. The reach a role held there is not carried to the Jobs or Leads scope: it was a separate choice.
    migration: '20261028101000_permission_document_scopes_retire',
    retired: ['estimates_scope', 'invoices_scope'],
    moves: [],
  },
  {
    // M9b (AL-10): display-only switches retire (a page opens with its module's View, the sidebar follows View), and their
    // stored rows are deleted.
    migration: '20261028100700_permission_display_switches_retire',
    retired: [
      'show_customers_page', 'show_leads_page', 'show_jobs_page', 'show_estimates_page', 'show_invoices_page',
      'show_service_plans_page', 'show_automations_page', 'show_tasks_page', 'show_users_teams_page', 'show_stock_page',
      'show_purchase_orders_page', 'show_vendors_page', 'show_logistic_orders_page', 'show_price_book_page', 'phone_usage_bar',
    ],
    moves: [],
  },
  {
    // M13 (AL-18): user and role management is the Admin flag's alone, so the five switches that stood for it are gone and
    // their stored rows deleted. No other switch takes their place.
    migration: '20261028130000_retire_user_role_switches',
    retired: ['create_users', 'invite_users', 'edit_users', 'delete_users', 'manage_roles_and_permissions'],
    moves: [],
  },
  {
    // M17 (ticket 36b): setting up the company is the Admin flag's alone, so the Company settings switch is gone and its stored
    // rows deleted. No other switch takes its place.
    migration: '20261029120000_retire_company_settings_switch',
    retired: ['company_settings'],
    moves: [],
  },
];

/** True when a later migration removed this key from the catalog on purpose (and carried its stored rows elsewhere). */
export function retiredByFollowUp(key: string): boolean {
  return PRESET_FOLLOW_UPS.some((f) => f.retired?.includes(key));
}

/** The follow-up move that carries `role`'s `key` from what the applied migration wrote to the catalog's value, if one does. */
export function followUpPresetMove(role: string, key: string, now: SwitchValue): PresetFollowUpMove | undefined {
  for (const f of PRESET_FOLLOW_UPS) {
    const move = f.moves.find((m) => m.role === role && m.key === key && sameSwitchValue(m.now, now));
    if (move) return move;
  }
  return undefined;
}

export interface PresetMigrationDrift {
  /** What differs between the SQL on disk and the frozen snapshot; empty when the file is as applied. */
  fileEdited: string[];
  /** Switches the migration wrote whose preset is now different, with the roles it differs for. */
  changed: Array<{ key: string; roles: Array<{ role: string; was: SwitchValue; now: SwitchValue }> }>;
  /** Switches the migration wrote that the catalog no longer holds (removed, or renamed). */
  removed: string[];
  kindChanged: Array<{ key: string; was: string; now: string }>;
  /** Switches the catalog holds that the migration did not write: informational. */
  added: string[];
}

export function presetMigrationDrift(
  sql: string,
  snapshot: PresetMigrationSnapshot = loadPresetMigrationSnapshot(),
  catalog: readonly SwitchEntry[] = SWITCH_CATALOG,
): PresetMigrationDrift {
  const parsed = parsePresetMigrationSql(sql, snapshot.migration);
  const fileEdited: string[] = [];
  if (!isDeepStrictEqual(parsed.switches, snapshot.switches)) fileEdited.push('the list of switches it writes');
  for (const role of new Set([...Object.keys(parsed.presets), ...Object.keys(snapshot.presets)])) {
    const now = parsed.presets[role] ?? {};
    const was = snapshot.presets[role] ?? {};
    for (const key of new Set([...Object.keys(now), ...Object.keys(was)])) {
      if (!isDeepStrictEqual(now[key], was[key])) fileEdited.push(`${role} ${key}`);
    }
  }

  const byKey = new Map(catalog.map((s) => [s.key, s]));
  const changed: PresetMigrationDrift['changed'] = [];
  const removed: string[] = [];
  const kindChanged: PresetMigrationDrift['kindChanged'] = [];
  for (const sw of snapshot.switches) {
    // A later migration may have renamed the key; the stored rows were carried to the new one.
    const live = byKey.get(sw.key) ?? byKey.get(renamedSwitchKey(sw.key) ?? '');
    if (!live) {
      if (!retiredByFollowUp(sw.key)) removed.push(sw.key);
      continue;
    }
    if (live.kind !== sw.kind) kindChanged.push({ key: sw.key, was: sw.kind, now: live.kind });
    const roles: PresetMigrationDrift['changed'][number]['roles'] = [];
    for (const [role, values] of Object.entries(snapshot.presets)) {
      const was = values[sw.key] as SwitchValue;
      const now = live.presets[role as keyof SwitchEntry['presets']];
      if (sameSwitchValue(was, now)) continue;
      // A later migration already carries the stored rows from `was` to `now`: not drift.
      const move = followUpPresetMove(role, sw.key, now);
      if (move && sameSwitchValue(move.was, was)) continue;
      roles.push({ role, was, now });
    }
    if (roles.length > 0) changed.push({ key: sw.key, roles });
  }
  const wrote = new Set(snapshot.switches.map((s) => s.key));
  return { fileEdited, changed, removed, kindChanged, added: catalog.filter((s) => !wrote.has(s.key)).map((s) => s.key) };
}

const show = (v: SwitchValue): string => (typeof v === 'string' ? v : JSON.stringify(v));

/** What the checker prints, and whether the tree is fine. */
export function formatPresetMigrationDrift(drift: PresetMigrationDrift): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  if (drift.fileEdited.length > 0) {
    lines.push(
      'The applied preset migration file no longer says what it said when it ran. It is applied: never rewrite it.',
      'Restore it (git checkout the file from the shared branch), then describe any change as a follow-up migration.',
      ...drift.fileEdited.slice(0, 20).map((d) => `  edited: ${d}`),
    );
    if (drift.fileEdited.length > 20) lines.push(`  ... and ${drift.fileEdited.length - 20} more`);
  }
  const needsFollowUp = drift.changed.length + drift.removed.length + drift.kindChanged.length > 0;
  if (needsFollowUp) {
    lines.push(
      'The catalog moved on after the preset migration ran, and stored rows still hold the old values: this needs a follow-up migration.',
      'Write a new file (set-based, idempotent, each change logged with reason "migration"); the applied file stays as it is.',
    );
    for (const c of drift.changed) {
      lines.push(`  preset changed: ${c.key} (${c.roles.map((r) => `${r.role}: ${show(r.was)} -> ${show(r.now)}`).join('; ')})`);
    }
    for (const k of drift.kindChanged) lines.push(`  kind changed: ${k.key} (${k.was} -> ${k.now})`);
    for (const k of drift.removed) lines.push(`  removed or renamed: ${k}`);
  }
  if (drift.added.length > 0) {
    lines.push(`Switches added after the migration (no action: a role with no stored row resolves to the preset): ${drift.added.join(', ')}`);
  }
  const ok = drift.fileEdited.length === 0 && !needsFollowUp;
  if (ok) lines.unshift('The preset migration is as applied, and no switch it wrote has changed its preset.');
  return { ok, lines };
}
