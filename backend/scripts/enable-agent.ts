import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';

const rawArgs = process.argv.slice(2);
const isDisable =
  rawArgs.includes('--disable') ||
  rawArgs.includes('-d') ||
  process.env.npm_lifecycle_event === 'agent:disable';

const cleanArgs = rawArgs.filter((a) => !a.startsWith('-'));
const agent = (cleanArgs[0] || 'bee').toLowerCase();
const orgId = cleanArgs[1];

async function main() {
  const org = orgId
    ? await prisma.organization.findUnique({ where: { id: orgId } })
    : await prisma.organization.findFirst();

  if (!org) {
    console.error('❌ Organization not found.');
    process.exit(1);
  }

  const currentOverrides =
    org.feature_overrides && typeof org.feature_overrides === 'object' && !Array.isArray(org.feature_overrides)
      ? (org.feature_overrides as Prisma.InputJsonObject)
      : {};
  const newOverrides: Prisma.InputJsonObject = { ...currentOverrides, [agent]: !isDisable };

  await prisma.organization.update({
    where: { id: org.id },
    data: { feature_overrides: newOverrides },
  });

  const action = isDisable ? 'disabled' : 'enabled';
  console.log(`\n✅ Successfully ${action} agent "${agent}" for: ${org.name} (${org.id})`);
  console.log(`   Updated feature_overrides:`, JSON.stringify(newOverrides));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
