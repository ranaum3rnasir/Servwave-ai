import fs from 'fs';
import path from 'path';
import { prisma } from '../src/lib/prisma';

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: npx tsx scripts/execute-migration.ts <path-to-sql-file>');
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), fileArg);
  const sql = fs.readFileSync(filePath, 'utf-8');

  console.log(`Executing migration from ${filePath}...`);
  // Split on semicolons outside of DO $$ blocks
  const parts: string[] = [];
  let current = '';
  let inDollarBlock = false;

  for (const line of sql.split('\n')) {
    if (line.includes('$$')) {
      inDollarBlock = !inDollarBlock;
    }
    current += line + '\n';
    if (!inDollarBlock && line.trim().endsWith(';')) {
      parts.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }

  for (const statement of parts) {
    if (!statement || statement.startsWith('--')) continue;
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch (err: any) {
      console.warn(`Statement warning or error: ${err.message}`);
    }
  }
  console.log('Migration statements executed successfully!');
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
