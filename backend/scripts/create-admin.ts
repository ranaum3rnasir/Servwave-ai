import { PrismaClient, Role } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import dotenv from 'dotenv';
import { runUnscoped } from '../src/lib/tenant-context';

dotenv.config();

const args = process.argv.slice(2);
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const ADMIN_EMAIL = arg('--email') || process.env.ADMIN_EMAIL || 'info@servwave.com';
const ADMIN_FIRST_NAME = arg('--first') || process.env.ADMIN_FIRST_NAME || 'Demo';
const ADMIN_LAST_NAME = arg('--last') || process.env.ADMIN_LAST_NAME || 'Admin';
const ORG_ID = arg('--org-id') || process.env.ORG_ID || '00000000-0000-0000-0000-000000000001';
const CLI_PASSWORD = arg('--password');

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
      console.log(`User ${ADMIN_EMAIL} already exists in organization ${existing.organization_id}. Skipping.`);
      return;
    }

    const password = CLI_PASSWORD || generatePassword();

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
        
        // Update password if one was supplied
        if (CLI_PASSWORD) {
          await supabase.auth.admin.updateUserById(supabaseUserId, { password: CLI_PASSWORD });
        }
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
    await runUnscoped(async () => {
      await prisma.user.create({
        data: {
          id: supabaseUserId,
          email: ADMIN_EMAIL,
          first_name: ADMIN_FIRST_NAME,
          last_name: ADMIN_LAST_NAME,
          role: Role.ADMIN,
          organization_id: ORG_ID,
          has_login: true,
        },
      });
    });

    console.log('\n✅ Admin user created successfully.');
    console.log(`   Organization ID: ${ORG_ID}`);
    console.log(`   Email:           ${ADMIN_EMAIL}`);
    console.log(`   Password:        ${password}`);
    console.log(`   Role:            ADMIN\n`);
  } catch (err) {
    console.error('create-admin failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
