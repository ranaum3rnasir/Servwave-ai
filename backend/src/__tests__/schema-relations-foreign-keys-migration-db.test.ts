/* =============================================================================
   The schema describes exactly what the migrations build: every relation schema.prisma declares has the foreign key in the
   database that the migrations create.

   A relation with no foreign key behind it is permanent drift (S10.9 declared four on `email_threads.record_id`, a bare id
   that names a row of whichever table `record_type` says, so four foreign keys on it could never all hold; the next
   `prisma migrate dev` would have proposed all four, and on an empty database that migration would have applied and then
   refused every record conversation). This builds a scratch database from the migrations the way Render does (the Prisma
   deploy command), reads its foreign keys from `pg_constraint`, and compares them with the relations Prisma's data model
   (DMMF) reports for EVERY model: a relation that owns its columns (`relationFromFields`) must have a foreign key on exactly
   those columns, to exactly that table.

   Skips when TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops a database.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { createMigrationDatabase, deployMigrations } from './migration-deploy-support';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`The schema relations suite creates and drops a database; refusing non-local host ${u.hostname}`);
  }
  return u;
}

/** Every relation the schema declares that owns its columns, as `table(columns)->referenced table`. */
function declaredRelations(): Map<string, string> {
  const models = Prisma.dmmf.datamodel.models;
  const byName = new Map(models.map((m) => [m.name, m]));
  const declared = new Map<string, string>();
  for (const model of models) {
    const table = model.dbName ?? model.name;
    for (const field of model.fields) {
      if (field.kind !== 'object' || !field.relationFromFields || field.relationFromFields.length === 0) continue;
      const column = (name: string) => model.fields.find((f) => f.name === name)?.dbName ?? name;
      const referenced = byName.get(field.type)!;
      declared.set(`${table}(${field.relationFromFields.map(column).join(',')})->${referenced.dbName ?? referenced.name}`, `${model.name}.${field.name}`);
    }
  }
  return declared;
}

suite('every relation schema.prisma declares has its foreign key in the migrated database (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const tempDirs: string[] = [];
  const databases: string[] = [];
  let scratch: PrismaClient | undefined;

  afterAll(async () => {
    await scratch?.$disconnect();
    for (const name of databases) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('has no relation without a foreign key (a relation on a polymorphic id can never have one)', async () => {
    const name = `fk_schema_${randomUUID().slice(0, 8)}`;
    const latest = readdirSync(MIGRATIONS).filter((entry) => entry !== 'migration_lock.toml').sort().pop()!;
    // A copy of the run's base plus the migrations after it leaves the same schema as the full history does.
    await createMigrationDatabase(admin, name, latest, tempDirs);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    deployMigrations(u.toString(), latest, 'through', tempDirs);

    scratch = new PrismaClient({ datasources: { db: { url: u.toString() } } });
    const keys = await scratch.$queryRawUnsafe<{ tbl: string; cols: string[]; ref: string }[]>(`
      SELECT cl.relname AS tbl, array_agg(a.attname ORDER BY k.ord) AS cols, rf.relname AS ref
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class rf ON rf.oid = c.confrelid
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
      GROUP BY c.oid, cl.relname, rf.relname`);
    const built = new Set(keys.map((k) => `${k.tbl}(${k.cols.join(',')})->${k.ref}`));

    const declared = declaredRelations();
    // The check is not vacuous: the schema has hundreds of relations and the database holds foreign keys for them.
    expect(declared.size).toBeGreaterThan(100);
    expect(built.size).toBeGreaterThan(100);
    const withoutKey = [...declared].filter(([key]) => !built.has(key)).map(([key, field]) => `${field} (${key})`);
    expect(withoutKey, 'relations in schema.prisma that no migration backs with a foreign key').toEqual([]);
  }, 600_000);
});
