import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { seedStarterTaskCategories } from './lib/tasks/categories';
import { seedListRows } from './lib/org-list-rows';
import { setFirstOwner } from './lib/users/first-owner';

dotenv.config();

const ORG_B_ID = '00000000-0000-0000-0000-000000000002';
const CUSTOMER_B_ID = '00000000-0000-0000-0000-0000000b0001';

async function main() {
  const prisma = new PrismaClient();
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    // 1. Create Org B
    await prisma.organization.upsert({
      where: { id: ORG_B_ID },
      update: {},   // do not stomp counters on re-run
      create: {
        id: ORG_B_ID,
        plan: 'SCALE',
        name: 'B&G Test Org',
        legal_name: 'B&G Test Org LLC',
        address_line1: '500 Test Blvd',
        city: 'Austin',
        state: 'TX',
        postal_code: '78702',
        country: 'US',
        email: 'admin@orgb-test.com',
        phone: '555-555-0002',
        estimate_terms: 'B&G test terms.',
        estimate_notes: '- B&G note',
        estimate_payment_terms: '- 50% deposit, 50% on completion',
        lead_prefix: 'BG-',
        estimate_prefix: 'BG-E-',
        job_prefix: 'BG-J-',
        invoice_prefix: 'BG-I-',
        number_padding: 5,
        // *_next_number columns use schema defaults of 1
      },
    });
    console.log(`Org B upserted: ${ORG_B_ID}`);
    // The starter task categories every new org gets (idempotent - safe on re-runs).
    await seedStarterTaskCategories(prisma, ORG_B_ID);
    await seedListRows(prisma, ORG_B_ID);

    // 2. Create Supabase auth + Prisma admin user
    const email = process.env.ORG_B_ADMIN_EMAIL || 'admin@orgb-test.com';
    const password = process.env.ORG_B_ADMIN_PASSWORD;
    if (!password || password.length < 16) {
      throw new Error('Set ORG_B_ADMIN_PASSWORD (at least 16 characters) before running this seed.');
    }
    const { data: supabaseUser, error: authErr } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    let supabaseUserId = supabaseUser?.user?.id;
    if (authErr && !authErr.message.includes('already')) throw authErr;
    if (!supabaseUserId) {
      // user already exists — paginate to find ID
      let page = 1;
      while (true) {
        const { data: listData } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
        const users = listData?.users || [];
        if (users.length === 0) break;
        const existingUser = users.find((u: any) => u.email === email);
        if (existingUser) { supabaseUserId = existingUser.id; break; }
        page++;
      }
      if (!supabaseUserId) throw new Error('Could not resolve Org B admin Supabase user ID');
    }

    await prisma.user.upsert({
      where: { id: supabaseUserId },
      update: { organization_id: ORG_B_ID },
      create: {
        id: supabaseUserId,
        email, first_name: 'Org', last_name: 'B Admin',
        role: 'ADMIN', is_admin: true, is_active: true,
        organization_id: ORG_B_ID,
      },
    });
    // The person the company is set up for is its Owner (AL-16). A re-run leaves an Owner already set alone.
    await setFirstOwner(prisma, ORG_B_ID, supabaseUserId);
    console.log(`Org B admin user upserted: ${email}`);

    // 3. Create one customer for Org B
    await prisma.customer.upsert({
      where: { id: CUSTOMER_B_ID },
      update: {},
      create: {
        id: CUSTOMER_B_ID,
        customer_number: 'C00001',
        first_name: 'Bob', last_name: 'OrgB',
        email: 'bob@orgb-test.com', phone: '5555550003',
        kind: 'PERSON', segment: 'RESIDENTIAL',
        organization_id: ORG_B_ID,
        // Creator tracking (audit only): a seeded customer was authored by the seeder, not a person.
        created_by_source: 'SYSTEM',
      },
    });
    console.log(`Org B sample customer upserted: ${CUSTOMER_B_ID}`);

    console.log('\nOrg B seed complete');
    console.log(`   Admin email:    ${email}`);
    console.log('   Admin password: the ORG_B_ADMIN_PASSWORD you provided.');
    console.log(`   Org ID:         ${ORG_B_ID}`);
  } catch (err) {
    console.error('Org B seed failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
