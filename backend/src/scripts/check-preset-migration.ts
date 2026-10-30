/**
 * Checks the APPLIED preset migration against the frozen snapshot of what it wrote (Roles & Permissions, slice S01.22).
 *
 * Migration 20261012120000_permission_preset_migration has run on staging, so its file is immutable (it must not be
 * rewritten, ever; it will run on production exactly as it is). This script used to regenerate the file from the
 * catalog; it no longer writes anything. It reports two different things:
 *
 *  - the file on disk is no longer what the snapshot (lib/permissions/switches/presetMigrationSnapshotData.ts) froze:
 *    someone edited an applied migration; restore it.
 *  - a catalog change made after the migration (a switch it wrote now has another preset or kind, or is gone): stored rows
 *    still hold the old values, so a FOLLOW-UP migration has to move them. The report names the switches.
 *
 * A switch added after the migration, and a changed grant mapping, need nothing (see presetMigrationDrift.ts).
 *
 * Run with: cd backend && npm run permissions:check-preset-migration
 * Exits 1 when the file was edited or a follow-up migration is needed, 0 otherwise.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PRESET_MIGRATION_NAME } from '../lib/permissions/switches/presetMigration';
import { formatPresetMigrationDrift, presetMigrationDrift } from '../lib/permissions/switches/presetMigrationDrift';

const file = join(__dirname, '..', '..', 'prisma', 'migrations', PRESET_MIGRATION_NAME, 'migration.sql');
const { ok, lines } = formatPresetMigrationDrift(presetMigrationDrift(readFileSync(file, 'utf8')));
for (const line of lines) (ok ? console.log : console.error)(line);
if (!ok) process.exitCode = 1;
