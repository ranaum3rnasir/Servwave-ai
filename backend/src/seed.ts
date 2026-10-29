import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const ADMIN_EMAIL = 'admin@servwave.com';
// Never hard-code a password. The seed reads it from the environment and refuses to run without one.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const ALPHA_ORG_ID = '00000000-0000-0000-0000-000000000001';

async function seed() {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 16) {
    throw new Error('Set SEED_ADMIN_PASSWORD (at least 16 characters) before running the seed.');
  }
  const prisma = new PrismaClient();
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    // Check if admin already exists
    const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (existing) {
      console.log('Admin user already exists. Skipping seed.');
      return;
    }

    // Create Supabase Auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      email_confirm: true,
    });

    if (authError || !authData.user) {
      throw new Error(`Supabase auth error: ${authError?.message}`);
    }

    // Create matching Prisma user
    await prisma.user.create({
      data: {
        id: authData.user.id,
        email: ADMIN_EMAIL,
        first_name: 'System',
        last_name: 'Admin',
        role: 'ADMIN',
        organization_id: ALPHA_ORG_ID,
      },
    });

    console.log('Admin user created.');
    console.log(`  Email: ${ADMIN_EMAIL}`);
    console.log('  Password: the SEED_ADMIN_PASSWORD you provided.');
    console.log('  Role: ADMIN');
    console.log('  Change the password after first login.');
    // ─── Seed default deposit & company settings ──────────
    const defaultSettings = [
      { key: 'deposit_required_default', value: 'true' },
      { key: 'deposit_percentage', value: '50' },
      { key: 'available_payment_methods', value: JSON.stringify(['CARD', 'BANK_TRANSFER', 'CHECK', 'CASH']) },
      { key: 'estimate_validity_days', value: '30' },
      { key: 'company_name', value: 'ServWave' },
      { key: 'bank_transfer_instructions', value: '' },
      { key: 'check_instructions', value: '' },
      { key: 'cash_instructions', value: '' },
      { key: 'estimate_email_template', value: 'Thank you for your recent service inquiry with us. Click the link below to view your estimate.' },
    ];

    for (const setting of defaultSettings) {
      await prisma.appSetting.upsert({
        where: { organization_id_key: { organization_id: ALPHA_ORG_ID, key: setting.key } },
        update: {},
        create: { ...setting, organization_id: ALPHA_ORG_ID },
      });
    }

    console.log(`Seeded ${defaultSettings.length} default settings.`);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
