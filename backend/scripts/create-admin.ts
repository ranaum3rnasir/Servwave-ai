import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// Override with ADMIN_EMAIL to create a different account.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@servwave.com';
const ADMIN_FIRST_NAME = process.env.ADMIN_FIRST_NAME || 'Demo';
const ADMIN_LAST_NAME = process.env.ADMIN_LAST_NAME || 'Admin';
const DEMO_ORG_ID = '00000000-0000-0000-0000-000000000001';

/** Generate a strong random password (>= 20 chars, mixed alphabet). */
function generatePassword(): string {
  const base = randomBytes(24).toString('base64').replace(/[+/=]/g, '');
  // Guarantee complexity: append a symbol, an upper, a lower, and a digit.
  return `${base.slice(0, 20)}A9z!`;
}

async function main() {
  const prisma = new PrismaClient();
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    // Idempotency: if the Prisma user row already exists, do nothing.
    const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (existing) {
      console.log(`User ${ADMIN_EMAIL} already exists. Skipping (no changes made).`);
      return;
    }

    const password = generatePassword();

    // Create the Supabase Auth user (email-confirmed so Google sign-in can link).
    let supabaseUserId: string | undefined;
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: ADMIN_EMAIL,
      password,
      email_confirm: true,
    });

    if (authError) {
      const msg = authError.message || '';
      // If the auth user already exists, reuse its id.
      if (/already.*registered|already.*exists/i.test(msg)) {
        console.log('Supabase auth user already registered; looking it up to reuse the id.');
        const { data: list, error: listError } = await supabase.auth.admin.listUsers();
        if (listError) throw new Error(`Supabase listUsers error: ${listError.message}`);
        const found = list.users.find(
          (u) => (u.email ?? '').toLowerCase() === ADMIN_EMAIL.toLowerCase()
        );
        if (!found) throw new Error('Auth user reported as existing but not found in listUsers.');
        supabaseUserId = found.id;
      } else {
        throw new Error(`Supabase auth error: ${msg}`);
      }
    } else if (authData?.user) {
      supabaseUserId = authData.user.id;
    }

    if (!supabaseUserId) {
      throw new Error('Could not resolve a Supabase auth user id.');
    }

    // Create the matching Prisma users row.
    await prisma.user.create({
      data: {
        id: supabaseUserId,
        email: ADMIN_EMAIL,
        first_name: ADMIN_FIRST_NAME,
        last_name: ADMIN_LAST_NAME,
        role: 'ADMIN',
        organization_id: DEMO_ORG_ID,
      },
    });

    console.log('Admin user created.');
    console.log(`  Email:    ${ADMIN_EMAIL}`);
    console.log(`  Password: ${password}`);
    console.log('  Role:     ADMIN');
    console.log(`  Org:      ${DEMO_ORG_ID}`);
    console.log('  (Google sign-in links by confirmed email; password is a fallback.)');
  } catch (err) {
    console.error('create-admin failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
