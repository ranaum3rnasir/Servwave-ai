/* Reads the switch list and the four preset value sets straight out of the preset migration's SQL. The parser lives
   in the library now (the drift checker needs it too); this keeps the tests' import path. */
export { parsePresetMigrationSql } from '../lib/permissions/switches/presetMigrationSnapshot';
