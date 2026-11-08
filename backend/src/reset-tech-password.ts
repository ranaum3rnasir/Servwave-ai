import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const TECH_EMAIL = process.env.TECH_EMAIL ?? 'tech@servwave.com';
const TECH_PASSWORD = process.env.TECH_PASSWORD;

if (!TECH_PASSWORD) {
  console.error('Error: TECH_PASSWORD env var is required');
  process.exit(1);
}

async function resetPassword() {
  const prisma = new PrismaClient();
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    // Find the user in Prisma
    const user = await prisma.user.findUnique({ where: { email: TECH_EMAIL } });
    if (!user) {
      console.log('Tech user not found in Prisma');
      return;
    }

    // Update password in Supabase Auth
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      password: TECH_PASSWORD,
    });

    if (error) {
      throw new Error(`Failed to reset password: ${error.message}`);
    }

    console.log('Password reset successful:');
    console.log(`  Email: ${TECH_EMAIL}`);
    console.log('  Password: (the value you supplied in TECH_PASSWORD — rotate after first login).');
  } catch (err) {
    console.error('Failed:', err);
  } finally {
    await prisma.$disconnect();
  }
}

resetPassword();
