/**
 * Creates the second demo organization: "ServWave Demo Two".
 *
 * This environment has exactly two organizations. Demo One carries the large
 * generated dataset (see seed-demo.ts); Demo Two is deliberately small. Its
 * purpose is tenant isolation: with a second populated org present, a missing
 * `tenantWhere(req)` shows up as Demo One's records leaking into Demo Two's
 * responses instead of passing unnoticed on a single-tenant database.
 *
 * Every value is invented. Emails use @example.com (reserved by RFC 2606) and
 * phone numbers use the 555 area code, which is not assignable in the North
 * American numbering plan.
 *
 * Idempotent: safe to re-run.
 */
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { seedStarterTaskCategories } from './lib/tasks/categories';

dotenv.config();

const DEMO_TWO_ORG_ID = '00000000-0000-0000-0000-000000000002';

/** Development only - rotate after first login. */
const ADMIN_PASSWORD = process.env.DEMO_TWO_ADMIN_PASSWORD || 'Sandbox123!@#';

const STAFF = [
  { id_suffix: 'a001', email: 'admin@demotwo.example.com', first_name: 'Robin',  last_name: 'Sandoval', role: 'ADMIN' as const,      phone: '+15555550401' },
  { id_suffix: 'a002', email: 'tech@demotwo.example.com',  first_name: 'Casey',  last_name: 'Lindqvist', role: 'TECHNICIAN' as const, phone: '+15555550402' },
];

const CUSTOMERS = [
  { id: '00000000-0000-0000-0000-0000000d2001', number: 'C00001', first_name: 'Alicia', last_name: 'Moreau',  email: 'alicia.moreau@example.com',  phone: '+15555550411', kind: 'PERSON'  as const, segment: 'RESIDENTIAL' as const, company: null },
  { id: '00000000-0000-0000-0000-0000000d2002', number: 'C00002', first_name: 'Devon',  last_name: 'Ashcroft', email: 'devon.ashcroft@example.com', phone: '+15555550412', kind: 'PERSON'  as const, segment: 'RESIDENTIAL' as const, company: null },
  { id: '00000000-0000-0000-0000-0000000d2003', number: 'C00003', first_name: 'Yara',   last_name: 'Benitez',  email: 'contact@northgate.example.com', phone: '+15555550413', kind: 'COMPANY' as const, segment: 'COMMERCIAL'  as const, company: 'Northgate Facilities' },
];

async function resolveAuthUserId(supabase: any, email: string): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: ADMIN_PASSWORD,
    email_confirm: true,
  });
  if (data?.user?.id) return data.user.id;
  if (error && !String(error.message).includes('already')) throw error;

  // Already present - page through to find the id.
  for (let page = 1; ; page++) {
    const { data: list } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    const users = list?.users ?? [];
    if (users.length === 0) break;
    const hit = users.find((u: any) => u.email === email);
    if (hit) return hit.id;
  }
  throw new Error(`Could not resolve Supabase user id for ${email}`);
}

async function main() {
  const prisma = new PrismaClient();
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    await prisma.organization.upsert({
      where: { id: DEMO_TWO_ORG_ID },
      update: {}, // do not stomp numbering counters on re-run
      create: {
        id: DEMO_TWO_ORG_ID,
        plan: 'SCALE',
        name: 'ServWave Demo Two',
        legal_name: 'ServWave Demo Two LLC',
        address_line1: '200 Example Avenue',
        city: 'Austin',
        state: 'TX',
        postal_code: '78702',
        country: 'US',
        email: 'info@demotwo.example.com',
        phone: '+15555550400',
        estimate_terms: 'Sample estimate terms for the second demo organization.',
        estimate_notes: '- Sample estimate note.',
        estimate_payment_terms: '- 50% deposit, 50% on completion',
        lead_prefix: 'D2-',
        estimate_prefix: 'D2-E-',
        job_prefix: 'D2-J-',
        invoice_prefix: 'D2-I-',
        number_padding: 5,
      },
    });
    console.log(`Organization upserted: ServWave Demo Two (${DEMO_TWO_ORG_ID})`);
    // The starter task categories every new org gets (idempotent - safe on re-runs).
    await seedStarterTaskCategories(prisma, DEMO_TWO_ORG_ID);

    for (const person of STAFF) {
      const userId = await resolveAuthUserId(supabase, person.email);
      await prisma.user.upsert({
        where: { id: userId },
        update: { organization_id: DEMO_TWO_ORG_ID },
        create: {
          id: userId,
          email: person.email,
          first_name: person.first_name,
          last_name: person.last_name,
          phone: person.phone,
          role: person.role,
          is_active: true,
          organization_id: DEMO_TWO_ORG_ID,
        },
      });
      console.log(`  + ${person.role.padEnd(10)} ${person.first_name} ${person.last_name} <${person.email}>`);
    }

    for (const c of CUSTOMERS) {
      await prisma.customer.upsert({
        where: { id: c.id },
        update: {},
        create: {
          id: c.id,
          customer_number: c.number,
          first_name: c.first_name,
          last_name: c.last_name,
          company_name: c.company,
          email: c.email,
          phone: c.phone,
          kind: c.kind,
          segment: c.segment,
          organization_id: DEMO_TWO_ORG_ID,
          // Audit only: a seeded customer was authored by the seeder, not a person.
          created_by_source: 'SYSTEM',
        },
      });
    }
    console.log(`  + ${CUSTOMERS.length} customers`);

    console.log('\nServWave Demo Two seed complete.');
    console.log(`  Admin: ${STAFF[0].email} / ${ADMIN_PASSWORD}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('ServWave Demo Two seed failed:', err);
  process.exit(1);
});
