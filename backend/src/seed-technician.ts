import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const TECH_EMAIL = process.env.TECH_EMAIL ?? 'tech@servwave.com';
const TECH_PASSWORD = process.env.TECH_PASSWORD;

if (!TECH_PASSWORD) {
  console.error('Error: TECH_PASSWORD env var is required');
  process.exit(1);
}

const DEMO_ORG_ID = '00000000-0000-0000-0000-000000000001';

async function seedTechnician() {
  const prisma = new PrismaClient();
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  try {
    // Check if tech already exists
    const existing = await prisma.user.findUnique({ where: { email: TECH_EMAIL } });
    let techUserId!: string;
    if (existing) {
      console.log('Technician user already exists. Skipping user creation.');
      techUserId = existing.id;
    } else {

    // Create or find Supabase Auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: TECH_EMAIL,
      password: TECH_PASSWORD,
      email_confirm: true,
    });

    if (authError?.message?.includes('already been registered')) {
      // User exists in Supabase, find their ID via paginated list
      let page = 1;
      let found = false;
      while (!found) {
        const { data: listData } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
        const users = listData?.users || [];
        if (users.length === 0) break;
        const existingUser = users.find((u: any) => u.email === TECH_EMAIL);
        if (existingUser) {
          techUserId = existingUser.id;
          found = true;
        }
        page++;
      }
      if (!found) throw new Error('User exists in auth but could not be found');
      console.log('Found existing Supabase auth user, reusing ID.');
    } else if (authError || !authData?.user) {
      throw new Error(`Supabase auth error: ${authError?.message}`);
    } else {
      techUserId = authData.user.id;
    }

    // Create Prisma user with TECHNICIAN role (if not already created)
    const existingPrismaUser = await prisma.user.findUnique({ where: { id: techUserId } });
    if (!existingPrismaUser) {
      await prisma.user.create({
        data: {
          id: techUserId,
          email: TECH_EMAIL,
          first_name: 'Mike',
          last_name: 'Rivera',
          role: 'TECHNICIAN',
          organization_id: DEMO_ORG_ID,
        },
      });
      console.log('Technician Prisma user created.');
    }

    console.log('Technician user ready:');
    console.log(`  Email: ${TECH_EMAIL}`);
    console.log('  Password: (the value you supplied in TECH_PASSWORD — rotate after first login).');
    console.log(`  Name: Mike Rivera`);
    console.log(`  Role: TECHNICIAN`);
    } // end of else block for user creation

    // Check if sample data already exists
    // S8 (D6): crew lives on the VISIT.
    const existingJobs = await prisma.job.findMany({ where: { visits: { some: { assignees: { some: { user_id: techUserId } } } } } });
    if (existingJobs.length > 0) {
      console.log(`\nSample data already exists (${existingJobs.length} jobs). Skipping.`);
      return;
    }

    // Create a sample customer
    const customer = await prisma.customer.create({
      data: {
        customer_number: 'C00001',
        first_name: 'Sarah',
        last_name: 'Johnson',
        email: 'sarah.johnson@example.com',
        phone: '(214) 555-0142',
        ad_source: 'REFERRAL',
        kind: 'PERSON', segment: 'RESIDENTIAL',
        organization_id: DEMO_ORG_ID,
        // Creator tracking (audit only): a seeded customer was authored by the seeder, not a person.
        created_by_source: 'SYSTEM',
      },
    });

    // Create service location
    const location = await prisma.serviceLocation.create({
      data: {
        customer_id: customer.id,
        address_line1: '742 Oak Street',
        city: 'Dallas',
        state: 'TX',
        zip: '75201',
        is_primary: true,
      },
    });

    // Create a second customer
    const customer2 = await prisma.customer.create({
      data: {
        customer_number: 'C00002',
        first_name: 'Tom',
        last_name: 'Williams',
        email: 'tom.williams@example.com',
        phone: '(972) 555-0238',
        ad_source: 'WEBSITE',
        kind: 'PERSON', segment: 'RESIDENTIAL',
        organization_id: DEMO_ORG_ID,
        // Creator tracking (audit only): a seeded customer was authored by the seeder, not a person.
        created_by_source: 'SYSTEM',
      },
    });

    const location2 = await prisma.serviceLocation.create({
      data: {
        customer_id: customer2.id,
        address_line1: '1205 Pine Avenue',
        city: 'Plano',
        state: 'TX',
        zip: '75074',
        is_primary: true,
      },
    });

    // Create a third customer
    const customer3 = await prisma.customer.create({
      data: {
        customer_number: 'C00003',
        first_name: 'Maria',
        last_name: 'Garcia',
        email: 'maria.garcia@example.com',
        phone: '(469) 555-0391',
        ad_source: 'GOOGLE',
        kind: 'PERSON', segment: 'RESIDENTIAL',
        organization_id: DEMO_ORG_ID,
        // Creator tracking (audit only): a seeded customer was authored by the seeder, not a person.
        created_by_source: 'SYSTEM',
      },
    });

    const location3 = await prisma.serviceLocation.create({
      data: {
        customer_id: customer3.id,
        address_line1: '890 Elm Drive',
        city: 'Richardson',
        state: 'TX',
        zip: '75080',
        is_primary: true,
      },
    });

    // Helper for job numbers
    const lastJob = await prisma.job.findFirst({ orderBy: { job_number: 'desc' } });
    let nextNum = lastJob ? parseInt(lastJob.job_number.replace('J', '')) + 1 : 1;

    const today = new Date();
    const makeTime = (hour: number, min: number) => {
      const d = new Date(today);
      d.setHours(hour, min, 0, 0);
      return d;
    };

    // Job 1: In Progress (current job)
    const job1 = await prisma.job.create({
      data: {
        job_number: `J${String(nextNum++).padStart(5, '0')}`,
        customer_id: customer.id,
        service_location_id: location.id,
        // S8 (D6): the crew rides on the job's trip, not on the job. The visit carries the same
        // window the job states, which is what makes the seeded technician reachable by OWN_JOB.
        visits: {
          create: {
            organization_id: DEMO_ORG_ID,
            purpose: 'WORK',
            visit_seq: 1,
            // Mirrors the job's own window below - S8's readers resolve schedule and duration off
            // the visit set now, and an un-timed seeded visit renders no time at all once they do.
            scheduled_at: makeTime(9, 0),
            scheduled_end: makeTime(11, 0),
            assignees: { create: { user_id: techUserId, organization_id: DEMO_ORG_ID } },
          },
        },
        organization_id: DEMO_ORG_ID,
        // Creator tracking (audit only): a seeded job was authored by the seeder, not a person.
        created_by_source: 'SYSTEM',
        scope_notes: 'AC Unit Repair — AC unit not cooling. Customer reports warm air blowing. Unit is a Carrier 24ACC636, installed 2019. Located on south side of house. Gate code is 4521. Dog in backyard — enter through side gate.',
        status: 'IN_PROGRESS',
        // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns - the visit
        // created above already carries the matching window, and the wire keys are now a
        // computed projection off it.
        started_at: makeTime(9, 8),
      },
    });

    // Job 2: Scheduled (upcoming)
    await prisma.job.create({
      data: {
        job_number: `J${String(nextNum++).padStart(5, '0')}`,
        customer_id: customer2.id,
        service_location_id: location2.id,
        // S8 (D6): the crew rides on the job's trip, not on the job. The visit carries the same
        // window the job states, which is what makes the seeded technician reachable by OWN_JOB.
        visits: {
          create: {
            organization_id: DEMO_ORG_ID,
            purpose: 'WORK',
            visit_seq: 1,
            // Mirrors the job's own window below - S8's readers resolve schedule and duration off
            // the visit set now, and an un-timed seeded visit renders no time at all once they do.
            scheduled_at: makeTime(11, 30),
            scheduled_end: makeTime(13, 30),
            assignees: { create: { user_id: techUserId, organization_id: DEMO_ORG_ID } },
          },
        },
        organization_id: DEMO_ORG_ID,
        // Creator tracking (audit only): a seeded job was authored by the seeder, not a person.
        created_by_source: 'SYSTEM',
        scope_notes: 'Furnace Installation — Install new Lennox SL280V furnace. Old unit removed by previous crew. Ductwork modification may be needed.',
        // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns - the visit
        // created above already carries the matching window.
        status: 'SCHEDULED',
      },
    });

    // Job 3: Scheduled (afternoon)
    await prisma.job.create({
      data: {
        job_number: `J${String(nextNum++).padStart(5, '0')}`,
        customer_id: customer3.id,
        service_location_id: location3.id,
        // S8 (D6): the crew rides on the job's trip, not on the job. The visit carries the same
        // window the job states, which is what makes the seeded technician reachable by OWN_JOB.
        visits: {
          create: {
            organization_id: DEMO_ORG_ID,
            purpose: 'WORK',
            visit_seq: 1,
            // Mirrors the job's own window below - S8's readers resolve schedule and duration off
            // the visit set now, and an un-timed seeded visit renders no time at all once they do.
            scheduled_at: makeTime(14, 30),
            scheduled_end: makeTime(16, 30),
            assignees: { create: { user_id: techUserId, organization_id: DEMO_ORG_ID } },
          },
        },
        organization_id: DEMO_ORG_ID,
        // Creator tracking (audit only): a seeded job was authored by the seeder, not a person.
        created_by_source: 'SYSTEM',
        scope_notes: 'Water Heater Replacement — Replace 40-gallon gas water heater. Customer wants tankless upgrade quote as well.',
        // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns - the visit
        // created above already carries the matching window.
        status: 'SCHEDULED',
      },
    });

    // Job 4: Scheduled (late afternoon)
    await prisma.job.create({
      data: {
        job_number: `J${String(nextNum++).padStart(5, '0')}`,
        customer_id: customer.id,
        service_location_id: location.id,
        // S8 (D6): the crew rides on the job's trip, not on the job. The visit carries the same
        // window the job states, which is what makes the seeded technician reachable by OWN_JOB.
        visits: {
          create: {
            organization_id: DEMO_ORG_ID,
            purpose: 'WORK',
            visit_seq: 1,
            // Mirrors the job's own window below - S8's readers resolve schedule and duration off
            // the visit set now, and an un-timed seeded visit renders no time at all once they do.
            scheduled_at: makeTime(17, 0),
            scheduled_end: makeTime(17, 45),
            assignees: { create: { user_id: techUserId, organization_id: DEMO_ORG_ID } },
          },
        },
        organization_id: DEMO_ORG_ID,
        // Creator tracking (audit only): a seeded job was authored by the seeder, not a person.
        created_by_source: 'SYSTEM',
        scope_notes: 'Thermostat Wiring Check — Follow-up from AC repair. Verify thermostat wiring after unit replacement.',
        // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns - the visit
        // created above already carries the matching window.
        status: 'SCHEDULED',
      },
    });

    // Add timeline events for job 1
    await prisma.timelineEvent.createMany({
      data: [
        {
          organization_id: DEMO_ORG_ID,
          entity_type: 'JOB',
          entity_id: job1.id,
          event_type: 'CREATED',
          description: 'Job created',
          created_at: makeTime(8, 0),
        },
        {
          organization_id: DEMO_ORG_ID,
          entity_type: 'JOB',
          entity_id: job1.id,
          event_type: 'ASSIGNED',
          description: 'Assigned to Mike Rivera',
          created_by: techUserId,
          created_at: makeTime(8, 30),
        },
        {
          organization_id: DEMO_ORG_ID,
          entity_type: 'JOB',
          entity_id: job1.id,
          event_type: 'STARTED',
          description: 'Job started',
          created_by: techUserId,
          created_at: makeTime(9, 8),
        },
      ],
    });

    console.log(`\nCreated 4 sample jobs assigned to Mike Rivera:`);
    console.log('  1. AC Unit Repair — IN_PROGRESS (9:00-11:00)');
    console.log('  2. Furnace Installation — SCHEDULED (11:30-1:30)');
    console.log('  3. Water Heater Replacement — SCHEDULED (2:30-4:30)');
    console.log('  4. Thermostat Wiring Check — SCHEDULED (5:00-5:45)');
    console.log('\nReady for mobile testing!');
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

seedTechnician();
