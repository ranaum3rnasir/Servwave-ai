/**
 * Creates the synthetic staff that seed-demo.ts expects to already exist.
 *
 * seed-demo.ts deliberately never creates users - it assigns work to
 * whoever is already on the org, and aborts if there is no DISPATCHER or
 * TECHNICIAN. A freshly migrated database only has the single ADMIN from
 * seed.ts, so the demo seed cannot run until this fills the other roles.
 *
 * Run order on a new database:
 *   npm run seed              # admin + default settings
 *   npm run seed:demo-staff   # this script
 *   npm run seed:demo   # the demo dataset
 *
 * Every value here is invented. Emails are @example.com (reserved by RFC 2606)
 * and phone numbers use the 555 area code, which is not assignable in the
 * North American numbering plan, so neither can reach a real person.
 *
 * Idempotent: users already present by email are skipped.
 */
import { PrismaClient, Role } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const DEMO_ORG_ID = '00000000-0000-0000-0000-000000000001';

/** Shared across every seeded account. Development only - rotate on first login. */
const STAFF_PASSWORD = 'Sandbox123!@#';

type StaffSeed = {
  first_name: string;
  last_name: string;
  email: string;
  role: Role;
  phone: string;
};

const STAFF: StaffSeed[] = [
  { first_name: 'Dana',   last_name: 'Whitfield', email: 'dana.dispatch@example.com',  role: 'DISPATCHER', phone: '+15555550301' },
  { first_name: 'Marcus', last_name: 'Ellery',    email: 'marcus.dispatch@example.com', role: 'DISPATCHER', phone: '+15555550302' },
  { first_name: 'Priya',  last_name: 'Raman',     email: 'priya.sales@example.com',     role: 'SALES',      phone: '+15555550303' },
  { first_name: 'Owen',   last_name: 'Brandt',    email: 'owen.sales@example.com',      role: 'SALES',      phone: '+15555550304' },
  { first_name: 'Terrell', last_name: 'Vance',    email: 'terrell.tech@example.com',    role: 'TECHNICIAN', phone: '+15555550305' },
  { first_name: 'Sofia',  last_name: 'Almeida',   email: 'sofia.tech@example.com',      role: 'TECHNICIAN', phone: '+15555550306' },
  { first_name: 'Hugo',   last_name: 'Petrov',    email: 'hugo.tech@example.com',       role: 'TECHNICIAN', phone: '+15555550307' },
  { first_name: 'Nadia',  last_name: 'Okonkwo',   email: 'nadia.tech@example.com',      role: 'TECHNICIAN', phone: '+15555550308' },
];

async function main() {
  const prisma = new PrismaClient();
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const org = await prisma.organization.findUnique({ where: { id: DEMO_ORG_ID } });
    if (!org) throw new Error(`Organization ${DEMO_ORG_ID} not found. Run migrations first.`);

    let created = 0;
    let skipped = 0;

    for (const person of STAFF) {
      const existing = await prisma.user.findUnique({ where: { email: person.email } });
      if (existing) {
        skipped++;
        continue;
      }

      const { data, error } = await supabase.auth.admin.createUser({
        email: person.email,
        password: STAFF_PASSWORD,
        email_confirm: true,
      });
      if (error || !data.user) {
        throw new Error(`Supabase auth error for ${person.email}: ${error?.message}`);
      }

      await prisma.user.create({
        data: {
          id: data.user.id,
          email: person.email,
          first_name: person.first_name,
          last_name: person.last_name,
          phone: person.phone,
          role: person.role,
          organization_id: DEMO_ORG_ID,
        },
      });
      created++;
      console.log(`  + ${person.role.padEnd(10)} ${person.first_name} ${person.last_name} <${person.email}>`);
    }

    console.log(`\nStaff seed complete. Created ${created}, skipped ${skipped} (already present).`);
    if (created > 0) {
      console.log(`Every seeded account uses the password: ${STAFF_PASSWORD}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
