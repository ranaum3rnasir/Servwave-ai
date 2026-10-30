import { isDeepStrictEqual } from 'util';
import { SWITCH_CATALOG, sameSwitchValue, type SwitchEntry, type SwitchValue } from './catalog';
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
    const live = byKey.get(sw.key);
    if (!live) {
      removed.push(sw.key);
      continue;
    }
    if (live.kind !== sw.kind) kindChanged.push({ key: sw.key, was: sw.kind, now: live.kind });
    const roles: PresetMigrationDrift['changed'][number]['roles'] = [];
    for (const [role, values] of Object.entries(snapshot.presets)) {
      const was = values[sw.key] as SwitchValue;
      const now = live.presets[role as keyof SwitchEntry['presets']];
      if (!sameSwitchValue(was, now)) roles.push({ role, was, now });
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
