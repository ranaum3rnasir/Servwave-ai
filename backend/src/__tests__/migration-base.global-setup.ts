/*
 * Vitest global setup: names this run's migration base template (see migration-deploy-support.ts) and drops it when the
 * run ends. It builds nothing: the first migration suite that needs the base builds it, with the real deploy command,
 * so a run with no migration suite pays nothing. The name carries the process id and a random part, so two runs on one
 * server never meet, and nothing is read from an earlier run: a base that is left behind by a killed run is never used,
 * because a new run always has a new name.
 */
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { isLeftoverBase } from './migration-deploy-support';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  // The migration suites create and drop databases, so they refuse a non-local server; so does this.
  if (!url || !LOCAL_HOSTS.includes(new URL(url).hostname)) return undefined;

  const name = `migration_base_${process.pid}_${randomBytes(4).toString('hex')}`;
  // Test workers are started after this and inherit it.
  process.env.MIGRATION_BASE_DB = name;

  return dropLeftoversThen(url, name);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
};

/**
 * A run that was cancelled or killed never reached its teardown and left its base behind. Housekeeping only: drop the
 * bases named for a process that no longer exists (never one of a run still going), then return this run's teardown.
 */
async function dropLeftoversThen(url: string, name: string) {
  const admin = new PrismaClient({ datasources: { db: { url } } });
  try {
    const rows = (await admin.$queryRawUnsafe(`SELECT datname FROM pg_database WHERE datname LIKE 'migration\\_base\\_%'`)) as { datname: string }[];
    for (const { datname } of rows) {
      if (isLeftoverBase(datname, alive)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => undefined);
    }
  } catch {
    // No server yet or no rights: nothing to tidy, and the run must not fail for it.
  } finally {
    await admin.$disconnect().catch(() => undefined);
  }

  return async () => {
    const admin = new PrismaClient({ datasources: { db: { url } } });
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } catch {
      // The server may already be gone; a dropped run must not turn red for it.
    } finally {
      await admin.$disconnect().catch(() => undefined);
    }
  };
}
