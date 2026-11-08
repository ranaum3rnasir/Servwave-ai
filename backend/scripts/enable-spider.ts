#!/usr/bin/env npx tsx
/**
 * Enable or disable Spider for any organization (demo or non-demo).
 *
 * Usage:
 *   npx tsx scripts/enable-spider.ts --org-id <uuid>
 *   npx tsx scripts/enable-spider.ts --org-id <uuid> --disable
 *   npx tsx scripts/enable-spider.ts --org-id <uuid> --status
 */
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';

const args = process.argv.slice(2);
const arg = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (f: string) => args.includes(f);

async function main() {
  const orgId = arg('--org-id');
  if (!orgId) {
    console.error('Usage: npx tsx scripts/enable-spider.ts --org-id <uuid> [--disable | --status]');
    process.exit(1);
  }

  await runUnscoped(async () => {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, is_demo: true, feature_overrides: true },
    });

    if (!org) {
      console.error(`❌ Organization not found: ${orgId}`);
      process.exit(1);
    }

    const currentOverrides = (org.feature_overrides ?? {}) as Record<string, unknown>;

    if (has('--status')) {
      console.log(`\nOrganization: ${org.name} (${org.id})`);
      console.log(`Demo Org:     ${org.is_demo ? 'Yes' : 'No'}`);
      console.log(`Spider State: ${org.is_demo || currentOverrides.spider === true ? '✅ ENABLED' : '❌ DISABLED'}`);
      console.log(`Overrides:    ${JSON.stringify(currentOverrides, null, 2)}\n`);
      return;
    }

    const disable = has('--disable');
    const newOverrides = {
      ...currentOverrides,
      spider: !disable,
    };

    const updated = await prisma.organization.update({
      where: { id: orgId },
      data: { feature_overrides: newOverrides },
      select: { id: true, name: true, is_demo: true, feature_overrides: true },
    });

    console.log(`\n✅ Successfully ${disable ? 'disabled' : 'enabled'} Spider for organization:`);
    console.log(`   Name:         ${updated.name}`);
    console.log(`   ID:           ${updated.id}`);
    console.log(`   Demo Org:     ${updated.is_demo ? 'Yes' : 'No'}`);
    console.log(`   Spider State: ${updated.is_demo || (updated.feature_overrides as any)?.spider === true ? '✅ ENABLED' : '❌ DISABLED'}`);
    console.log(`   Overrides:    ${JSON.stringify(updated.feature_overrides)}\n`);
    console.log(`💡 Note: If currently logged into the app, refresh or wait up to 60s for the auth token cache to pick up the change.\n`);
  });
}

main()
  .catch((e) => {
    console.error('Error running enable-spider:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

