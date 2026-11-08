import { prisma } from '../src/lib/prisma';

async function check() {
  const tables = await prisma.$queryRawUnsafe<any[]>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'bee_%' ORDER BY table_name"
  );
  console.log('Bee tables in DB:', tables);
}

check()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });

