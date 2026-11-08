/**
 * seed-demo.ts - generates the dataset for "ServWave Demo One".
 *
 * Fills the first demo organization (00000000-0000-0000-0000-000000000001) with
 * a rich, time-distributed field-service CRM dataset so the Dashboard, Schedule,
 * Reports and every DB-backed list/detail screen render real content instead of
 * empty states.
 *
 * ALL DATA IS INVENTED. Names come from fixed pools, emails use @example.com
 * (reserved by RFC 2606) and phone numbers use the 555 area code, which is not
 * assignable in the North American numbering plan. Never add real names, real
 * email addresses or real phone numbers here.
 *
 * SAFETY:
 *   - refuses unless SEED_DEMO === 'true'
 *   - only ever writes to the demo org id (...0001)
 *
 * PREREQUISITE: seed-demo-staff.ts must have run. This script assigns work to
 * existing staff and never creates users, so it aborts when the org has no
 * dispatcher or technician.
 *
 * IDEMPOTENT: an FK-safe wipe of the org's CRM transactional rows runs first,
 * then a single curated dataset is reseeded with all dates re-anchored to
 * `new Date()`. Re-runs reproduce the same fresh-dated dataset (counts do not
 * double). Existing org users, app_settings, the organization, departments and
 * locations, price book, and the brand/vendor/inventory/communication catalogs
 * are NEVER deleted.
 *
 * Run: SEED_DEMO=true npx tsx src/seed-demo.ts
 */
import { PrismaClient, Prisma } from '@prisma/client';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { demoVisitsForLeadStatus } from './lib/demo-walkthrough-visits';

dotenv.config();

// ── Constants & safety boundaries ───────────────────────────────────────────
const DEMO_ORG_ID = '00000000-0000-0000-0000-000000000001';

const CHUNK = 500;

// ── Tiny seeded PRNG so a given "now" deterministically reproduces the dataset ─
let _seed = 0xc0ffee;
function rnd(): number {
  // xorshift32
  _seed ^= _seed << 13;
  _seed ^= _seed >>> 17;
  _seed ^= _seed << 5;
  return ((_seed >>> 0) % 1_000_000) / 1_000_000;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}
function randInt(min: number, max: number): number {
  return Math.floor(rnd() * (max - min + 1)) + min;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Date helpers (all anchored to runtime `now`) ─────────────────────────────
const NOW = new Date();
function daysAgo(d: number): Date {
  const x = new Date(NOW);
  x.setDate(x.getDate() - d);
  return x;
}
function daysFromNow(d: number): Date {
  return daysAgo(-d);
}
function hoursFromNow(h: number): Date {
  return new Date(NOW.getTime() + h * 3600 * 1000);
}
/** A date `d` days ago, at a given hour:minute (local). */
function atTime(date: Date, hour: number, minute = 0): Date {
  const x = new Date(date);
  x.setHours(hour, minute, 0, 0);
  return x;
}
function todayAt(hour: number, minute = 0): Date {
  return atTime(NOW, hour, minute);
}
const MONTH_START = new Date(NOW.getFullYear(), NOW.getMonth(), 1);
const WEEK_START = (() => {
  const t = new Date(NOW);
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() - t.getDay());
  return t;
})();

// ── Catalogs (door / locks / access control theme) ──────────────────────────
const JOB_TYPES = [
  'Lock Rekey',
  'Access Control Install',
  'Storefront Door Repair',
  'Panic Hardware',
  'Gate Operator',
  'CCTV / Camera Install',
  'Safe Install & Service',
  'Commercial Door Replacement',
] as const;

const LEAD_SOURCES = ['google', 'referral', 'website', 'repeat', 'yelp', 'angi', 'facebook'] as const;

const LOST_REASONS = ['PRICE', 'TIMING', 'COMPETITOR', 'NO_RESPONSE', 'OTHER'] as const;
const PAYMENT_METHODS = ['CARD', 'CASH', 'CHECK', 'BANK_TRANSFER'] as const;
// Placeholder consent mark for seeded PENDING estimates (a 1x1 transparent PNG). Deliberately
// not a rendering of anyone's name — seed data must never carry real or realistic-looking PII.
const DEMO_SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Realistic door/security line items: [description, unitPrice, isMaterial]
const LINE_ITEMS: Array<[string, number, boolean]> = [
  ['Schlage B660P Single-Cylinder Deadbolt, 626 Satin Chrome', 78, true],
  ['Mul-T-Lock MT5+ High-Security Cylinder', 145, true],
  ['Von Duprin 99 Series Rim Exit Device (Panic Bar)', 685, true],
  ['LCN 4040XP Heavy-Duty Surface Door Closer', 440, true],
  ['HES 1006 Electric Strike, 12/24 VDC', 315, true],
  ['HID ProxPoint Plus Card Reader, Wiegand 26', 195, true],
  ['Honeywell Pro 2200 2-Door Access Control Panel', 1290, true],
  ['Hikvision 4MP ColorVu Turret IP Camera', 168, true],
  ['Hikvision 8-Channel 4K NVR, 2TB', 540, true],
  ['LiftMaster CSL24UL Commercial Slide Gate Operator', 2950, true],
  ['Storefront Aluminum Door, Narrow Stile, Clear Anodized', 1850, true],
  ['Adams Rite 4710 Deadlatch, Standard Backset', 132, true],
  ['Detex EAX-500 Exit Alarm', 245, true],
  ['Kaba Simplex 1000 Mechanical Pushbutton Lock', 410, true],
  ['AMSEC BWB3020 B-Rate Burglary Safe', 1395, true],
  ['Door Weatherseal Kit, Commercial Frame + Bottom Sweep', 85, true],
  ['Locksmith Labor — On-Site Service Call', 165, false],
  ['Access Control Programming & Commissioning', 285, false],
  ['Standard Rekey — Up to 6 Cylinders', 189, false],
  ['Storefront Door Adjustment & Alignment', 220, false],
  ['CCTV System Configuration & Remote View Setup', 240, false],
  ['Gate Operator Maintenance & Safety Inspection', 195, false],
  ['Emergency After-Hours Service Premium', 250, false],
  ['Annual Hardware Preventive Maintenance Visit', 175, false],
];

const COMMERCIAL_NAMES = [
  'Meridian Property Group', 'Brookline Dental Associates', 'Hudson Storage Co.',
  'Riverside Auto Body', 'Lakeview Pharmacy', 'Summit Financial Center',
  'Greenfield Grocers', 'Park Avenue Jewelers', 'Atlas Logistics Warehouse',
  'Westgate Medical Plaza', 'Coastal Title & Escrow', 'Ironworks Brewing Co.',
  'Pinnacle Law Offices', 'Sunrise Childcare Center', 'Harbor Point Marina',
  'Cedar Ridge Apartments', 'Downtown Eye Clinic', 'Liberty Self Storage',
  'Maplewood Veterinary', 'Granite State Credit Union',
];
const FIRST_NAMES = [
  'James', 'Maria', 'Robert', 'Linda', 'David', 'Patricia', 'Michael', 'Jennifer',
  'William', 'Elizabeth', 'Richard', 'Susan', 'Joseph', 'Karen', 'Thomas', 'Nancy',
  'Daniel', 'Sandra', 'Paul', 'Ashley', 'Mark', 'Kimberly', 'Steven', 'Emily',
  'Andrew', 'Donna', 'Kenneth', 'Carol', 'Joshua', 'Michelle', 'Brian', 'Amanda',
  'George', 'Melissa', 'Edward', 'Rebecca', 'Ronald', 'Laura', 'Anthony', 'Sharon',
];
const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker',
  'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
];
const STREETS = [
  'Main St', 'Oak Ave', 'Maple Dr', 'Washington Blvd', 'Park Ave', 'Cedar Ln',
  'Elm St', 'Lincoln Ave', 'Lake Rd', 'Hillcrest Dr', 'Sunset Blvd', 'River Rd',
  'Church St', 'Market St', 'Highland Ave', 'Franklin St', 'Madison Ave', 'Bridge St',
];
const CITIES: Array<[string, string, string]> = [
  ['Newark', 'NJ', '07102'], ['Jersey City', 'NJ', '07302'], ['Edison', 'NJ', '08817'],
  ['Paterson', 'NJ', '07501'], ['Elizabeth', 'NJ', '07201'], ['Trenton', 'NJ', '08608'],
  ['Hoboken', 'NJ', '07030'], ['Clifton', 'NJ', '07011'], ['Passaic', 'NJ', '07055'],
];

const SERVICE_REQUESTS = [
  'Front door deadbolt sticking, needs rekey after tenant move-out',
  'Install card-access system on rear employee entrance',
  'Storefront door closer leaking and won\'t latch',
  'Panic bar failing inspection on fire exit',
  'Automatic slide gate stuck halfway, motor humming',
  'Add 4-camera CCTV coverage to parking lot',
  'Deliver and bolt down a burglary-rated safe in back office',
  'Replace damaged aluminum storefront door after break-in',
  'Master-key the whole suite, 12 cylinders',
  'Mag-lock on server room door not releasing on power loss',
];

// ── Run ─────────────────────────────────────────────────────────────────────
async function main() {
  // SAFETY GUARD (throws before any write). This seed WIPES the target org's
  // CRM rows before reseeding, so it must never run by accident.
  if (process.env.SEED_DEMO !== 'true') {
    throw new Error('Refusing to run: set SEED_DEMO=true to enable the demo seed.');
  }
  const orgId = DEMO_ORG_ID;

  const prisma = new PrismaClient();
  try {
    const orgRow = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!orgRow) throw new Error(`Demo organization ${orgId} not found on this DB. Run migrations first.`);
    const org = orgRow; // non-null binding so nested closures keep the narrowing
    console.log(`\nSeeding demo data into "${org.name}" (${orgId})`);
    console.log(`Anchoring all dates to now = ${NOW.toISOString()}\n`);

    const pad = org.number_padding;
    const fmt = (prefix: string, n: number) => `${prefix}${String(n).padStart(pad, '0')}`;

    // ── 1. Load existing staff (we never create users) ─────────────────────
    const users = await prisma.user.findMany({
      where: { organization_id: orgId },
      select: { id: true, role: true, first_name: true, last_name: true },
    });
    const admins = users.filter((u) => u.role === 'ADMIN');
    const sales = users.filter((u) => u.role === 'SALES');
    const dispatchers = users.filter((u) => u.role === 'DISPATCHER');
    const techs = users.filter((u) => u.role === 'TECHNICIAN');
    if (dispatchers.length === 0 || techs.length === 0) {
      throw new Error('Expected dispatchers and technicians on the demo org; run seed-demo-staff.ts first.');
    }
    // Lead owners = SALES + ADMIN (fall back to admins if no SALES).
    const leadOwners = (sales.length ? sales : admins).concat(admins);
    const anyUser = admins[0] ?? users[0];
    const creatorId = anyUser.id;

    // ── 2. FK-SAFE WIPE (demo org only) ───────────────────────────────────
    // Order derived from live FK delete-rules (RESTRICT children first). Comms/
    // inventory rows referencing these CRM rows are ON DELETE SET NULL, so they
    // survive — we never touch the catalog/communication tables here.
    console.log('Wiping previous demo-org CRM rows (FK-safe order)…');
    const orgWhere = { organization_id: orgId };
    const invByOrg = { invoice: { organization_id: orgId } };
    await prisma.refund.deleteMany({ where: orgWhere });
    await prisma.depositCreditApplication.deleteMany({ where: orgWhere });
    await prisma.credit.deleteMany({ where: orgWhere });
    await prisma.payment.deleteMany({ where: invByOrg });
    await prisma.invoiceLineItem.deleteMany({ where: { invoice: { organization_id: orgId } } });
    await prisma.invoice.deleteMany({ where: orgWhere });
    await prisma.planVisit.deleteMany({ where: orgWhere });
    await prisma.job.deleteMany({ where: orgWhere });
    await prisma.servicePlanLineItem.deleteMany({ where: orgWhere });
    await prisma.servicePlan.deleteMany({ where: orgWhere });
    await prisma.estimateSendConfig.deleteMany({ where: { estimate: { organization_id: orgId } } });
    await prisma.estimateLineItem.deleteMany({ where: { estimate: { organization_id: orgId } } });
    await prisma.estimate.deleteMany({ where: orgWhere });
    await prisma.leadAssignee.deleteMany({ where: orgWhere });
    await prisma.visitAssignee.deleteMany({ where: orgWhere });
    await prisma.visit.deleteMany({ where: orgWhere });
    await prisma.leadTag.deleteMany({ where: { lead: { organization_id: orgId } } });
    await prisma.lead.deleteMany({ where: orgWhere });
    await prisma.note.deleteMany({ where: orgWhere });
    await prisma.timelineEvent.deleteMany({ where: orgWhere });
    await prisma.tagAssignment.deleteMany({ where: orgWhere });
    await prisma.attachment.deleteMany({ where: orgWhere });
    await prisma.serviceLocation.deleteMany({ where: { customer: { organization_id: orgId } } });
    await prisma.customerPhone.deleteMany({ where: { customer: { organization_id: orgId } } });
    await prisma.customerEmail.deleteMany({ where: { customer: { organization_id: orgId } } });
    await prisma.customer.deleteMany({ where: orgWhere });

    // ── 3. BUILD DATASET IN MEMORY ─────────────────────────────────────────
    let custNum = 1;
    let leadNum = 1;
    let estNum = 1;
    let jobNum = 1;
    let invNum = 1;
    let spNum = 1;

    const customerRows: Prisma.CustomerCreateManyInput[] = [];
    const emailRows: Prisma.CustomerEmailCreateManyInput[] = [];
    const phoneRows: Prisma.CustomerPhoneCreateManyInput[] = [];
    const locationRows: Prisma.ServiceLocationCreateManyInput[] = [];
    const leadRows: Prisma.LeadCreateManyInput[] = [];
    const leadAssigneeRows: Prisma.LeadAssigneeCreateManyInput[] = [];
    const walkthroughRows: Prisma.VisitCreateManyInput[] = [];
    const walkPerformerRows: Prisma.VisitAssigneeCreateManyInput[] = [];
    // S8 (D6): the job-side trips and the crew on them. Separate arrays only so the insert order
    // below stays readable - both land in `visits` / `visit_assignees`.
    const jobVisitRows: Prisma.VisitCreateManyInput[] = [];
    const jobVisitCrewRows: Prisma.VisitAssigneeCreateManyInput[] = [];
    const estimateRows: Prisma.EstimateCreateManyInput[] = [];
    const estLineRows: Prisma.EstimateLineItemCreateManyInput[] = [];
    const jobRows: Prisma.JobCreateManyInput[] = [];
    const invoiceRows: Prisma.InvoiceCreateManyInput[] = [];
    const invLineRows: Prisma.InvoiceLineItemCreateManyInput[] = [];
    const paymentRows: Prisma.PaymentCreateManyInput[] = [];
    const planRows: Prisma.ServicePlanCreateManyInput[] = [];
    const planLineRows: Prisma.ServicePlanLineItemCreateManyInput[] = [];
    const planVisitRows: Prisma.PlanVisitCreateManyInput[] = [];
    const timelineRows: Prisma.TimelineEventCreateManyInput[] = [];

    // Unique contact generators (avoid dup-guard collisions).
    // 555 is not an assignable NANP area code, so every generated number is
    // guaranteed fictional and cannot reach a real subscriber.
    let phoneCounter = 2010000; // base; each customer gets a unique 555-### number
    const usedEmails = new Set<string>();
    function uniquePhone(): string {
      phoneCounter += randInt(7, 53);
      const n = String(phoneCounter).padStart(7, '0').slice(-7);
      return `+1555${n}`;
    }
    function uniqueEmail(base: string): string {
      let slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
      let email = `${slug}@example.com`;
      let i = 2;
      while (usedEmails.has(email)) email = `${slug}${i++}@example.com`;
      usedEmails.add(email);
      return email;
    }

    type CustInfo = {
      id: string;
      isCommercial: boolean;
      displayName: string;
      primaryLocationId: string;
      locationIds: string[];
    };
    const customers: CustInfo[] = [];

    function addCustomer(opts: {
      isCommercial: boolean;
      parentId?: string | null;
      isParent?: boolean;
      extraLocations?: number;
      createdAt: Date;
    }): CustInfo {
      const id = randomUUID();
      const isCommercial = opts.isCommercial;
      let displayName: string;
      let first: string | null = null;
      let last: string | null = null;
      let company: string | null = null;
      if (isCommercial) {
        company = pick(COMMERCIAL_NAMES) + (rnd() < 0.3 ? ` #${randInt(2, 9)}` : '');
        displayName = company;
        first = pick(FIRST_NAMES);
        last = pick(LAST_NAMES);
      } else {
        first = pick(FIRST_NAMES);
        last = pick(LAST_NAMES);
        displayName = `${first} ${last}`;
      }
      const phone = uniquePhone();
      const email = uniqueEmail(isCommercial ? company! : `${first}.${last}`);

      customerRows.push({
        id,
        customer_number: fmt(org.customer_prefix, custNum++),
        email,
        phone,
        kind: isCommercial ? 'COMPANY' : 'PERSON',
        segment: isCommercial ? 'COMMERCIAL' : 'RESIDENTIAL',
        first_name: first,
        last_name: last,
        company_name: company,
        is_active: true,
        is_parent: opts.isParent ?? false,
        parent_id: opts.parentId ?? null,
        source: pick(LEAD_SOURCES),
        organization_id: orgId,
        created_at: opts.createdAt,
        updated_at: opts.createdAt,
        // Creator tracking (audit only): a seeded row was authored by the seeder, not a person.
        created_by_source: 'SYSTEM' as const,
      });

      // extra email + phone records
      emailRows.push({ id: randomUUID(), customer_id: id, email, label: 'Primary' });
      phoneRows.push({ id: randomUUID(), customer_id: id, phone, label: 'Mobile', is_primary: true });
      if (rnd() < 0.35) {
        phoneRows.push({ id: randomUUID(), customer_id: id, phone: uniquePhone(), label: 'Office', is_primary: false });
      }

      // service locations (1, sometimes 2 for commercial)
      const locCount = 1 + (isCommercial && (opts.extraLocations ?? 0) > 0 ? 1 : 0);
      const locationIds: string[] = [];
      for (let i = 0; i < locCount; i++) {
        const locId = randomUUID();
        const [city, state, zip] = pick(CITIES);
        locationRows.push({
          id: locId,
          customer_id: id,
          address_line1: `${randInt(10, 9999)} ${pick(STREETS)}`,
          address_line2: isCommercial && rnd() < 0.5 ? `Suite ${randInt(100, 480)}` : null,
          city,
          state,
          zip,
          is_primary: i === 0,
          is_active: true,
          created_at: opts.createdAt,
        });
        locationIds.push(locId);
      }
      const info: CustInfo = { id, isCommercial, displayName, primaryLocationId: locationIds[0], locationIds };
      customers.push(info);
      return info;
    }

    // 3a. CUSTOMERS (~60): 70% residential / 30% commercial spread over 12 months.
    //     One commercial parent (property-mgmt) with 3–4 child accounts.
    const TARGET_CUSTOMERS = 60;
    // Parent + children franchise group first.
    const parent = addCustomer({ isCommercial: true, isParent: true, extraLocations: 1, createdAt: daysAgo(330) });
    for (let i = 0; i < randInt(3, 4); i++) {
      addCustomer({ isCommercial: true, parentId: parent.id, extraLocations: i === 0 ? 1 : 0, createdAt: daysAgo(randInt(40, 320)) });
    }
    while (customers.length < TARGET_CUSTOMERS) {
      const isCommercial = rnd() < 0.3;
      addCustomer({
        isCommercial,
        extraLocations: isCommercial && rnd() < 0.3 ? 1 : 0,
        createdAt: daysAgo(randInt(2, 345)),
      });
    }

    // Helper: build a set of line items, return {lines, subtotal}
    function buildLines(count: number): { items: Array<[string, number, number, boolean]>; subtotal: number } {
      const items: Array<[string, number, number, boolean]> = [];
      let subtotal = 0;
      // always at least one labor/service line
      const labor = pick(LINE_ITEMS.filter((l) => !l[2]));
      const lq = 1;
      items.push([labor[0], lq, labor[1], labor[2]]);
      subtotal += lq * labor[1];
      for (let i = 1; i < count; i++) {
        const li = pick(LINE_ITEMS);
        const q = li[2] ? randInt(1, 4) : 1;
        items.push([li[0], q, li[1], li[2]]);
        subtotal += q * li[1];
      }
      return { items, subtotal: round2(subtotal) };
    }

    const TAX_RATE = 0.06625; // NJ
    function lineItemsFor(parentId: string, items: Array<[string, number, number, boolean]>, kind: 'est' | 'inv') {
      items.forEach(([desc, qty, price, isMaterial], idx) => {
        const lineTotal = round2(qty * price);
        const row = {
          id: randomUUID(),
          sequence: idx + 1,
          description: desc,
          quantity: qty,
          unit_price: price,
          is_taxable: isMaterial,
          line_total: lineTotal,
          item_type: (isMaterial ? 'MATERIAL' : 'SERVICE') as 'MATERIAL' | 'SERVICE',
        };
        if (kind === 'est') estLineRows.push({ ...row, estimate_id: parentId });
        else invLineRows.push({ ...row, invoice_id: parentId });
      });
    }
    function totalsFor(items: Array<[string, number, number, boolean]>): { subtotal: number; tax: number; total: number } {
      let subtotal = 0;
      let taxable = 0;
      for (const [, qty, price, isMaterial] of items) {
        const lt = qty * price;
        subtotal += lt;
        if (isMaterial) taxable += lt;
      }
      const tax = round2(taxable * TAX_RATE);
      return { subtotal: round2(subtotal), tax, total: round2(round2(subtotal) + tax) };
    }

    // 3b. LEADS (~130). We engineer status mix + dates so the dashboard lights up.
    // Buckets:
    //   WON      ~60 (drive jobs + revenue; spread WON updated_at across last-30 & prior-30)
    //   LOST     ~25 (with lost_reason; spread updated_at across last-30 & prior-30)
    //   open     ~25 across NEW/CONTACTED/WALKTHROUGH_*/ESTIMATED (~18 created THIS month)
    //   extra    ~20 older WON to feed the 12-month completed-job history
    type LeadInfo = {
      id: string;
      custId: string;
      locId: string;
      ownerId: string;
      source: string;
      jobType: string;
      status: string;
      createdAt: Date;
      serviceRequest: string;
    };
    const wonLeads: LeadInfo[] = [];

    function addLead(opts: {
      custId: string;
      locId: string;
      status: string;
      createdAt: Date;
      updatedAt?: Date;
      assign?: boolean;
      contacted?: boolean;
      lostReason?: string | null;
      lostAt?: Date | null;
    }): LeadInfo {
      const id = randomUUID();
      const ownerUser = pick(leadOwners);
      const source = pick(LEAD_SOURCES);
      const jobType = pick(JOB_TYPES);
      const sr = pick(SERVICE_REQUESTS);
      const createdAt = opts.createdAt;
      const updatedAt = opts.updatedAt ?? createdAt;
      const assign = opts.assign ?? true;

      leadRows.push({
        id,
        lead_number: fmt(org.lead_prefix, leadNum++),
        customer_id: opts.custId,
        service_location_id: opts.locId, // NOT NULL in staging — always supply
        status: opts.status as any,
        service_request: sr,
        job_type: jobType,
        source,
        contacted_at: opts.contacted === false ? null : (opts.contacted ? daysAgo(randInt(0, 3)) : new Date(createdAt.getTime() + 3600 * 1000)),
        lost_reason: opts.lostReason ?? null,
        lost_at: opts.lostAt ?? null,
        commission_owner_id: ownerUser.id,
        organization_id: orgId,
        created_at: createdAt,
        updated_at: updatedAt,
        // Creator tracking (audit only): a seeded row was authored by the seeder, not a person.
        created_by_source: 'SYSTEM' as const,
      });
      if (assign) {
        leadAssigneeRows.push({ id: randomUUID(), lead_id: id, user_id: ownerUser.id, organization_id: orgId });
      }
      // Seed real Visit rows that AGREE with the lead's status (demoVisitsForLeadStatus): Walkthrough
      // Scheduled gets one open visit, Walkthrough Completed gets finished visits and nothing open,
      // every other status gets none. Multi-visit D22a: "needs scheduling" is the ABSENCE of a live
      // visit, so a lead that needs one gets NO row at all.
      const visits = demoVisitsForLeadStatus(opts.status, {
        scheduledAt: daysFromNow(randInt(1, 6)),
        completedAt: daysAgo(randInt(1, 9)),
      });
      visits.forEach((v, idx) => {
        const walkthroughId = randomUUID();
        walkthroughRows.push({
          id: walkthroughId,
          organization_id: orgId,
          lead_id: id,
          purpose: 'WALKTHROUGH',
          visit_seq: idx + 1,
          status: v.status,
          scheduled_at: v.scheduled_at,
          completed_at: v.completed_at,
          created_at: createdAt,
          updated_at: updatedAt,
        });
        walkPerformerRows.push({ id: randomUUID(), visit_id: walkthroughId, user_id: pick(techs).id, organization_id: orgId });
      });
      return { id, custId: opts.custId, locId: opts.locId, ownerId: ownerUser.id, source, jobType, status: opts.status, createdAt, serviceRequest: sr };
    }

    const custCycle = () => customers[randInt(0, customers.length - 1)];

    // WON leads (~60) — spread updated_at to feed close-rate delta (last-30 vs prior-30).
    for (let i = 0; i < 60; i++) {
      const c = custCycle();
      const created = daysAgo(randInt(35, 345));
      // half of recently-updated WON inside last-30, some in prior-30 for a positive delta
      let updated: Date;
      if (i < 22) updated = daysAgo(randInt(1, 29)); // last-30 WON
      else if (i < 34) updated = daysAgo(randInt(31, 59)); // prior-30 WON
      else updated = daysAgo(randInt(60, 330));
      wonLeads.push(addLead({ custId: c.id, locId: c.primaryLocationId, status: 'WON', createdAt: created, updatedAt: updated }));
    }

    // LOST leads (~25) with lost_reason; mix last-30 / prior-30 (fewer than WON → ~68% close).
    for (let i = 0; i < 25; i++) {
      const c = custCycle();
      const created = daysAgo(randInt(20, 200));
      let updated: Date;
      if (i < 10) updated = daysAgo(randInt(1, 29)); // last-30 LOST (10 lost vs 22 won → ~69%)
      else if (i < 16) updated = daysAgo(randInt(31, 59)); // prior-30 LOST (6 lost vs 12 won → ~67%)
      else updated = daysAgo(randInt(60, 190));
      addLead({
        custId: c.id, locId: c.primaryLocationId, status: 'LOST', createdAt: created, updatedAt: updated,
        lostReason: pick(LOST_REASONS), lostAt: updated,
      });
    }

    // Open leads (~25) across the funnel, five per open status; ~18 created this month (pipeline
    // head). Walkthrough Scheduled and Walkthrough Completed leads carry visits that agree with
    // their status (see addLead / demoVisitsForLeadStatus); the other statuses carry none.
    const OPEN_STATUSES = ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] as const;
    for (let i = 0; i < 25; i++) {
      const c = custCycle();
      // 18 created this month, rest a bit older but still open
      const created = i < 18
        ? new Date(MONTH_START.getTime() + Math.floor(rnd() * (NOW.getTime() - MONTH_START.getTime())))
        : daysAgo(randInt(32, 75));
      const status = OPEN_STATUSES[i % OPEN_STATUSES.length];
      // ~6 unassigned + open (unassigned KPI). A few NEW/CONTACTED carry no contact stamp at all.
      const unassigned = i < 6;
      const noContactRecorded = i >= 6 && i < 10 && (status === 'NEW' || status === 'CONTACTED'); // assigned, but contacted_at stays null
      addLead({
        custId: c.id,
        locId: c.primaryLocationId,
        status,
        createdAt: created,
        assign: !unassigned,
        contacted: noContactRecorded ? false : status !== 'NEW',
      });
    }

    // Extra older WON (~20) to back-fill the 12-month completed-job history.
    for (let i = 0; i < 20; i++) {
      const c = custCycle();
      const created = daysAgo(randInt(120, 360));
      wonLeads.push(addLead({ custId: c.id, locId: c.primaryLocationId, status: 'WON', createdAt: created, updatedAt: daysAgo(randInt(95, 350)) }));
    }

    // 3c. ESTIMATES (~90). ~55 WON, ~12 SENT/PENDING (2–3 expiring <72h),
    //     ~10 DRAFT, ~10 REJECTED(DECLINED). Each linked to a lead; set job_type + lead_source.
    type EstInfo = { id: string; leadId: string; lead: LeadInfo; status: string; total: number; items: Array<[string, number, number, boolean]>; approvedAt: Date | null };
    const approvedEstimates: EstInfo[] = [];

    function addEstimate(lead: LeadInfo, status: string, opts: { validUntil?: Date | null; approvedAt?: Date | null; sentAt?: Date | null; lostReason?: string | null; createdAt: Date }): EstInfo {
      const id = randomUUID();
      const { items } = buildLines(randInt(2, 6));
      const t = totalsFor(items);
      lineItemsFor(id, items, 'est');
      estimateRows.push({
        id,
        lead_id: lead.id,
        // R6 (2026-07-22) — mirrors the create() denormalization: every real estimate carries its
        // lead's customer_id/service_location_id from the moment it exists, seeded data included.
        customer_id: lead.custId,
        service_location_id: lead.locId,
        estimate_number: fmt(org.estimate_prefix, estNum++),
        status: status as any,
        subtotal: t.subtotal,
        tax_amount: t.tax,
        total_amount: t.total,
        tax_rate: TAX_RATE,
        job_type: lead.jobType,
        lead_source: lead.source,
        lost_reason: (opts.lostReason ?? null) as any,
        sent_at: opts.sentAt ?? null,
        approved_at: opts.approvedAt ?? null,
        declined_at: status === 'DECLINED' ? opts.createdAt : null,
        // D6 (2026-07-21): PENDING means the customer approved AND signed — only the deposit is
        // outstanding. A PENDING row with no signature is not a state the app can produce, and
        // seeding one makes the demo org contradict every gate that keys off "is this signed?".
        // Derived from status here, not passed per call site, so it cannot be forgotten.
        ...(status === 'PENDING'
          ? { signature_data: DEMO_SIGNATURE_PNG, signature_at: opts.sentAt ?? opts.createdAt }
          : {}),
        valid_until: opts.validUntil ?? null,
        created_by: creatorId,
        organization_id: orgId,
        created_at: opts.createdAt,
        updated_at: opts.approvedAt ?? opts.sentAt ?? opts.createdAt,
      });
      const info: EstInfo = { id, leadId: lead.id, lead, status, total: t.total, items, approvedAt: opts.approvedAt ?? null };
      if (status === 'WON') approvedEstimates.push(info);
      return info;
    }

    // WON (~55): ~12 approved THIS month, rest spread over the year.
    const wonForEstimates = [...wonLeads];
    for (let i = 0; i < 55; i++) {
      const lead = wonForEstimates[i % wonForEstimates.length];
      const approvedAt = i < 12
        ? new Date(MONTH_START.getTime() + Math.floor(rnd() * (NOW.getTime() - MONTH_START.getTime())))
        : daysAgo(randInt(32, 340));
      const sentAt = new Date(approvedAt.getTime() - randInt(1, 6) * 86400000);
      addEstimate(lead, 'WON', { approvedAt, sentAt, validUntil: new Date(approvedAt.getTime() + 30 * 86400000), createdAt: sentAt });
    }
    // SENT/PENDING (~12): 3 expiring within 72h, rest valid further out.
    const openishLeads = leadRows.filter((l) => ['ESTIMATED', 'CONTACTED'].includes(l.status as string));
    for (let i = 0; i < 12; i++) {
      // attach to any lead (reuse won leads is fine; estimate carries its own data)
      const baseLead = wonForEstimates[(i + 7) % wonForEstimates.length];
      // The first 3 are the "expiring within 72h" demo cohort and must stay SENT: a PENDING
      // estimate is already accepted (D6) and is deliberately excluded from the expiration
      // sweep, so seeding one as expiring-soon would demo a state the cron can never reach.
      const status = i >= 3 && i % 3 === 0 ? 'PENDING' : 'SENT';
      const created = daysAgo(randInt(1, 20));
      const validUntil = i < 3 ? hoursFromNow(randInt(12, 70)) : daysFromNow(randInt(7, 25));
      addEstimate(baseLead, status, { sentAt: created, validUntil, createdAt: created });
    }
    // DRAFT (~10)
    for (let i = 0; i < 10; i++) {
      const baseLead = wonForEstimates[(i + 13) % wonForEstimates.length];
      addEstimate(baseLead, 'DRAFT', { createdAt: daysAgo(randInt(0, 30)) });
    }
    // DECLINED / rejected (~10)
    for (let i = 0; i < 10; i++) {
      const baseLead = wonForEstimates[(i + 19) % wonForEstimates.length];
      const created = daysAgo(randInt(10, 120));
      addEstimate(baseLead, 'DECLINED', { sentAt: created, lostReason: pick(LOST_REASONS), createdAt: created });
    }

    // 3d. JOBS (~180). Built mostly from approved estimates / WON leads.
    //     Status/date engineering per the dashboard buckets.
    type JobBuild = {
      id: string;
      custId: string;
      locId: string;
      estimateId: string | null;
      status: string;
      scheduledStart: Date | null;
      scheduledEnd: Date | null;
      completedAt: Date | null;
      amountInvoiced: number;
      items: Array<[string, number, number, boolean]>;
      total: number;
      crew: string[];
      jobType: string;
    };
    const jobs: JobBuild[] = [];
    const usedEstimateIds = new Set<string>();

    function crewPick(): string[] {
      const size = randInt(1, 3);
      const shuffled = [...techs].sort(() => rnd() - 0.5);
      return shuffled.slice(0, size).map((t) => t.id);
    }

    function addJob(opts: {
      lead: LeadInfo;
      estimate?: EstInfo | null;
      status: string;
      scheduledStart: Date | null;
      scheduledEnd?: Date | null;
      completedAt?: Date | null;
      createdAt: Date;
      assignCrew?: boolean;
      total?: number;
      items?: Array<[string, number, number, boolean]>;
    }): JobBuild {
      const id = randomUUID();
      const est = opts.estimate ?? null;
      const items = opts.items ?? est?.items ?? buildLines(randInt(2, 5)).items;
      const total = opts.total ?? (est ? est.total : totalsFor(items).total);
      const crew = (opts.assignCrew ?? true) ? crewPick() : [];
      const dispatcher = pick(dispatchers);
      const completed = opts.status === 'COMPLETED';
      const amountInvoiced = completed ? total : 0;
      const start = opts.scheduledStart;
      const end = opts.scheduledEnd ?? (start ? new Date(start.getTime() + randInt(1, 4) * 3600000) : null);

      let estimateId: string | null = null;
      if (est && !usedEstimateIds.has(est.id)) {
        estimateId = est.id;
        usedEstimateIds.add(est.id);
      }

      jobRows.push({
        id,
        job_number: fmt(org.job_prefix, jobNum++),
        customer_id: opts.lead.custId,
        service_location_id: opts.lead.locId,
        estimate_id: estimateId,
        status: opts.status as any,
        // S8 (RATIFIED, A5): scheduled_start/scheduled_end DROPPED as job columns - Prisma.
        // JobCreateManyInput no longer carries them. The visit booked below (now unconditional on
        // `start`, not on `crew.length > 0`) is the real window; the wire keys are a computed
        // projection off it.
        scope_notes: opts.lead.serviceRequest,
        completed_at: opts.completedAt ?? (completed ? (start ?? opts.createdAt) : null),
        amount_invoiced: amountInvoiced,
        dispatcher_id: dispatcher.id,
        organization_id: orgId,
        created_at: opts.createdAt,
        updated_at: opts.completedAt ?? start ?? opts.createdAt,
        // Creator tracking (audit only): a seeded job was authored by the seeder, not a person.
        created_by_source: 'SYSTEM' as const,
      });
      // Multi-visit S8 (D6): crew lives on the VISIT, so a seeded crewed job gets a real trip to
      // carry it. A crew row with no trip would be unreachable by OWN_JOB, which is now a
      // `visits.some.assignees.some` predicate - the seeded technician would see nothing.
      //
      // S8 (RATIFIED, A5) fix, found via this PR's own Step 0 re-grep (not named in the
      // contract's snapshot): the guard was `if (crew.length > 0)`, so ~5 of the 120 HISTORY jobs
      // seeded crewless (deliberately, `assignCrew = i % 25 !== 0`) got NO visit row at all.
      // Before this PR that only meant an uncrewed job with no per-visit crew list; after it, it
      // would ALSO mean the job's scheduled_start/scheduled_end projection reads null forever -
      // a "scheduled"/"completed" seeded job silently showing no date. Booking now follows `start`
      // (matching the real create() door's own rule: a time given books a trip, independent of
      // crew), with the crew rows staying conditional on `crew.length > 0` beneath it.
      if (start) {
        const jobVisitId = randomUUID();
        jobVisitRows.push({
          id: jobVisitId,
          organization_id: orgId,
          job_id: id,
          purpose: 'WORK',
          visit_seq: 1,
          status: completed ? 'COMPLETED' : opts.status === 'CANCELLED' ? 'CANCELLED' : 'SCHEDULED',
          scheduled_at: start,
          scheduled_end: end,
          created_at: opts.createdAt,
          updated_at: opts.completedAt ?? start ?? opts.createdAt,
        });
        for (const uid of crew) {
          jobVisitCrewRows.push({ id: randomUUID(), visit_id: jobVisitId, user_id: uid, organization_id: orgId });
        }
      }
      const jb: JobBuild = {
        id, custId: opts.lead.custId, locId: opts.lead.locId, estimateId,
        status: opts.status, scheduledStart: start, scheduledEnd: end,
        completedAt: opts.completedAt ?? (completed ? (start ?? opts.createdAt) : null),
        amountInvoiced, items, total, crew, jobType: opts.lead.jobType,
      };
      jobs.push(jb);
      return jb;
    }

    // Map approved estimates → won leads (the estimate's lead is the source of customer/loc).
    const approvedQueue = [...approvedEstimates];
    let aqi = 0;
    const nextApproved = (): EstInfo | null => (aqi < approvedQueue.length ? approvedQueue[aqi++] : null);

    // -- TODAY: ~9 across SCHEDULED/IN_PROGRESS/COMPLETED, incl 2 past-start SCHEDULED. S4 (D17)
    // retired EN_ROUTE/ON_SITE from JobStatus - a crew on the way or on site is a VISIT state.
    const nowHour = NOW.getHours();
    const todayPlan: Array<{ status: string; start: Date }> = [
      { status: 'SCHEDULED', start: todayAt(Math.min(23, Math.max(nowHour + 1, 9))) },
      { status: 'SCHEDULED', start: todayAt(Math.min(23, Math.max(nowHour + 3, 11))) },
      // two past-start, still SCHEDULED → needs-attention
      { status: 'SCHEDULED', start: atTime(NOW, Math.max(7, nowHour - 2)) },
      { status: 'SCHEDULED', start: atTime(NOW, Math.max(6, nowHour - 3)) },
      { status: 'IN_PROGRESS', start: atTime(NOW, Math.max(7, nowHour - 1)) },
      { status: 'SCHEDULED', start: atTime(NOW, Math.max(7, nowHour - 1)) },
      { status: 'IN_PROGRESS', start: atTime(NOW, Math.max(7, nowHour - 2)) },
      { status: 'COMPLETED', start: todayAt(8) },
      { status: 'COMPLETED', start: todayAt(10) },
    ];
    for (const p of todayPlan) {
      // Only COMPLETED jobs consume an approved estimate (widgets read completed only).
      const est = p.status === 'COMPLETED' ? nextApproved() : null;
      const lead = est ? est.lead : wonLeads[randInt(0, wonLeads.length - 1)];
      addJob({
        lead, estimate: est, status: p.status, scheduledStart: p.start,
        completedAt: p.status === 'COMPLETED' ? new Date(p.start.getTime() + 2 * 3600000) : null,
        createdAt: daysAgo(randInt(2, 14)),
      });
    }

    // -- THIS WEEK: ~15 COMPLETED (completed_at this week, excluding today) + ~20 SCHEDULED (future this week).
    for (let i = 0; i < 15; i++) {
      const est = nextApproved();
      const lead = est ? est.lead : wonLeads[randInt(0, wonLeads.length - 1)];
      // a day earlier this week (between week start and yesterday)
      const dayOffset = randInt(1, Math.max(1, NOW.getDay()));
      const day = daysAgo(dayOffset);
      const start = atTime(day, randInt(8, 15));
      addJob({ lead, estimate: est, status: 'COMPLETED', scheduledStart: start, completedAt: new Date(start.getTime() + 2 * 3600000), createdAt: daysAgo(dayOffset + randInt(3, 14)) });
    }
    // Scheduled/future jobs deliberately carry NO approved estimate so the limited
    // pool of approved estimates is reserved for COMPLETED jobs (Revenue-by-Job-Type
    // + Lead-Sources-revenue widgets read job→estimate only on completed jobs).
    for (let i = 0; i < 20; i++) {
      const lead = wonLeads[randInt(0, wonLeads.length - 1)];
      // future day this week (today+1 .. saturday) or early next-week spill
      const dayOffset = randInt(1, 5);
      const start = atTime(daysFromNow(dayOffset), randInt(8, 16));
      addJob({ lead, estimate: null, status: 'SCHEDULED', scheduledStart: start, createdAt: daysAgo(randInt(2, 12)) });
    }

    // -- FUTURE: ~12 scheduled beyond this week (coming-up).
    for (let i = 0; i < 12; i++) {
      const lead = wonLeads[randInt(0, wonLeads.length - 1)];
      const start = atTime(daysFromNow(randInt(8, 40)), randInt(8, 16));
      addJob({ lead, estimate: null, status: 'SCHEDULED', scheduledStart: start, createdAt: daysAgo(randInt(0, 10)) });
    }

    // -- HISTORY: ~120 COMPLETED across 12 months (completed_at + amount_invoiced).
    //    Distribute across months with a gently rising recent skew; a few unassigned (no crew).
    const HISTORY = 120;
    for (let i = 0; i < HISTORY; i++) {
      const est = nextApproved();
      const lead = est ? est.lead : wonLeads[randInt(0, wonLeads.length - 1)];
      // bias toward more recent months (rnd^1.4 → skew toward 0 = recent)
      const monthsBack = Math.floor(Math.pow(rnd(), 1.4) * 12); // 0..11
      const baseDay = monthsBack * 30 + randInt(1, 28);
      const day = daysAgo(Math.max(7, baseDay)); // keep out of "this week" bucket
      const start = atTime(day, randInt(8, 16));
      const assignCrew = i % 25 !== 0; // ~5 unassigned (no crew)
      addJob({ lead, estimate: est, status: 'COMPLETED', scheduledStart: start, completedAt: new Date(start.getTime() + 2 * 3600000), createdAt: daysAgo(baseDay + randInt(3, 20)), assignCrew });
    }

    // 3e. INVOICES (~130) + PAYMENTS (~110).
    //   STANDARD invoices for most completed jobs; DEPOSIT-kind (~25) from approved estimates.
    //   Statuses: ~85 PAID, ~20 SENT, ~8 PARTIAL, ~5 DRAFT, ~3 VOIDED.
    //   due_date spans current / over-30 / over-60; several SENT/PARTIAL overdue.
    //   Some DEPOSIT unpaid SENT/PARTIAL (deposits-awaiting) + some created this month.
    const completedJobs = jobs.filter((j) => j.status === 'COMPLETED');

    type InvBuild = { id: string; total: number; status: string; createdAt: Date; isDeposit: boolean };
    const invoices: InvBuild[] = [];

    function addInvoice(opts: {
      jobId: string | null;
      customerId: string;
      estimateId?: string | null;
      servicePlanId?: string | null;
      kind: 'STANDARD' | 'DEPOSIT' | 'PLAN';
      status: string;
      items: Array<[string, number, number, boolean]>;
      createdAt: Date;
      dueDate: Date | null;
      sentAt?: Date | null;
      paidAt?: Date | null;
      depositFraction?: number;
    }): InvBuild {
      const id = randomUUID();
      const t = totalsFor(opts.items);
      let total = t.total;
      let subtotal = t.subtotal;
      let tax = t.tax;
      if (opts.kind === 'DEPOSIT' && opts.depositFraction) {
        total = round2(t.total * opts.depositFraction);
        subtotal = round2(t.subtotal * opts.depositFraction);
        tax = round2(t.tax * opts.depositFraction);
      }
      // amount_due depends on status
      let amountDue = total;
      if (opts.status === 'PAID') amountDue = 0;
      else if (opts.status === 'PARTIAL') amountDue = round2(total * 0.5);
      else if (opts.status === 'VOIDED') amountDue = 0;

      invoiceRows.push({
        id,
        invoice_number: fmt(org.invoice_prefix, invNum++),
        job_id: opts.jobId,
        customer_id: opts.customerId,
        estimate_id: opts.estimateId ?? null,
        service_plan_id: opts.servicePlanId ?? null,
        kind: opts.kind,
        status: opts.status as any,
        subtotal,
        tax_amount: tax,
        total_amount: total,
        amount_due: amountDue,
        tax_rate: TAX_RATE,
        due_date: opts.dueDate,
        sent_at: opts.sentAt ?? null,
        paid_at: opts.paidAt ?? null,
        voided_at: opts.status === 'VOIDED' ? opts.createdAt : null,
        voided_reason: opts.status === 'VOIDED' ? 'Issued in error — superseded by corrected invoice' : null,
        organization_id: orgId,
        created_at: opts.createdAt,
        updated_at: opts.paidAt ?? opts.sentAt ?? opts.createdAt,
        // Creator tracking (audit only): a seeded row was authored by the seeder, not a person.
        created_by_source: 'SYSTEM' as const,
      });
      // DEPOSIT invoices have no line items in this model snapshot; STANDARD/PLAN do.
      if (opts.kind !== 'DEPOSIT') lineItemsFor(id, opts.items, 'inv');
      const ib: InvBuild = { id, total, status: opts.status, createdAt: opts.createdAt, isDeposit: opts.kind === 'DEPOSIT' };
      invoices.push(ib);
      return ib;
    }

    // Standard invoices for completed jobs. Status distribution target across ~105:
    //   PAID 85, SENT 17, PARTIAL 8, VOIDED 3, (DRAFT handled separately)
    // We'll tag statuses round-robin to hit roughly those counts.
    const stdStatusPlan: string[] = [
      ...Array(85).fill('PAID'),
      ...Array(17).fill('SENT'),
      ...Array(8).fill('PARTIAL'),
      ...Array(3).fill('VOIDED'),
    ];
    // shuffle so statuses interleave across the timeline
    for (let i = stdStatusPlan.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [stdStatusPlan[i], stdStatusPlan[j]] = [stdStatusPlan[j], stdStatusPlan[i]];
    }
    let spi = 0;
    for (const job of completedJobs) {
      if (spi >= stdStatusPlan.length) break;
      const status = stdStatusPlan[spi++];
      const createdAt = job.completedAt ? new Date(job.completedAt.getTime() + 3600000) : job.scheduledStart ?? daysAgo(10);
      // due 15 days after invoice
      const dueDate = new Date(createdAt.getTime() + 15 * 86400000);
      let sentAt: Date | null = createdAt;
      let paidAt: Date | null = null;
      let finalDue = dueDate;
      if (status === 'PAID') {
        paidAt = new Date(createdAt.getTime() + randInt(1, 20) * 86400000);
        if (paidAt > NOW) paidAt = new Date(NOW.getTime() - 3600000);
      } else if (status === 'SENT' || status === 'PARTIAL') {
        // Make several overdue: if invoice is old, due_date < now.
        // (created in the past → dueDate already < now for older ones)
        finalDue = dueDate;
      } else if (status === 'VOIDED') {
        sentAt = null;
      }
      addInvoice({
        jobId: job.id, customerId: job.custId, estimateId: job.estimateId, kind: 'STANDARD',
        status, items: job.items, createdAt, dueDate: finalDue, sentAt, paidAt,
      });
    }

    // DRAFT standard invoices (~5) — recent, no due/sent.
    for (let i = 0; i < 5; i++) {
      const job = completedJobs[(completedJobs.length - 1 - i + completedJobs.length) % completedJobs.length];
      addInvoice({
        jobId: job.id, customerId: job.custId, estimateId: null, kind: 'STANDARD',
        status: 'DRAFT', items: job.items, createdAt: daysAgo(randInt(0, 8)), dueDate: null, sentAt: null, paidAt: null,
      });
    }

    // DEPOSIT invoices (~25) from approved estimates: 50% deposits.
    //   ~12 PAID (deposit collected), ~9 SENT/PARTIAL unpaid (deposits-awaiting KPI),
    //   several created THIS month (pipeline deposit).
    const depEstimates = approvedEstimates.slice(0, 25);
    depEstimates.forEach((est, i) => {
      const thisMonth = i < 8;
      const createdAt = thisMonth
        ? new Date(MONTH_START.getTime() + Math.floor(rnd() * (NOW.getTime() - MONTH_START.getTime())))
        : daysAgo(randInt(20, 200));
      let status: string;
      let paidAt: Date | null = null;
      if (i < 14) {
        status = 'PAID';
        paidAt = new Date(createdAt.getTime() + randInt(1, 5) * 86400000);
        if (paidAt > NOW) paidAt = new Date(NOW.getTime() - 3600000);
      } else if (i < 20) {
        status = 'SENT'; // awaiting deposit
      } else {
        status = 'PARTIAL';
      }
      addInvoice({
        jobId: null, customerId: est.lead.custId, estimateId: est.id, kind: 'DEPOSIT',
        status, items: est.items, createdAt, dueDate: new Date(createdAt.getTime() + 7 * 86400000),
        sentAt: createdAt, paidAt, depositFraction: 0.5,
      });
    });

    // 3f. PAYMENTS (~110) — for PAID (full) + PARTIAL (half) invoices.
    //   paid_at across 12 months w/ a gently rising monthly trend; ~5 collected today.
    const payableInvoices = invoices.filter((inv) => inv.status === 'PAID' || inv.status === 'PARTIAL');
    // Deterministically pick 5 of the most recent PAID invoices to have been collected TODAY
    // (collected-today KPI). Most recent = created closest to now.
    const TODAY_PAYMENT_COUNT = 5;
    const recentPaid = [...payableInvoices]
      .filter((inv) => inv.status === 'PAID')
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, TODAY_PAYMENT_COUNT);
    const todayPaidIds = new Set(recentPaid.map((i) => i.id));
    for (const inv of payableInvoices) {
      const amount = inv.status === 'PAID' ? inv.total : round2(inv.total * 0.5);
      let paidAt: Date;
      if (todayPaidIds.has(inv.id)) {
        // collected today, earlier than "now"
        const maxHour = Math.max(9, NOW.getHours());
        paidAt = todayAt(randInt(8, maxHour), randInt(0, 59));
        if (paidAt >= NOW) paidAt = new Date(NOW.getTime() - randInt(30, 240) * 60000);
      } else {
        // Anchor payment near the invoice's createdAt.
        paidAt = new Date(inv.createdAt.getTime() + randInt(1, 18) * 86400000);
        if (paidAt > NOW) paidAt = new Date(NOW.getTime() - randInt(2, 96) * 3600000);
      }
      paymentRows.push({
        id: randomUUID(),
        invoice_id: inv.id,
        amount,
        method: pick(PAYMENT_METHODS) as any,
        paid_at: paidAt,
        collected_by: pick([...dispatchers, ...techs]).id,
        reference_number: `REF-${randInt(100000, 999999)}`,
        // Creator tracking (audit only): a seeded row was authored by the seeder, not a person.
        created_by_source: 'SYSTEM' as const,
      });
    }

    // 3g. SERVICE PLANS (~8 ACTIVE) with line items + upcoming visits.
    const PLAN_NAMES = [
      'Annual Door Hardware Maintenance', 'Quarterly Access Control Service',
      'CCTV Monitoring & Maintenance', 'Storefront Door PM Program',
      'Gate Operator Service Contract', 'Commercial Lock Maintenance Plan',
      'Panic Hardware Inspection Plan', 'Safe & Vault Service Agreement',
    ];
    const CADENCES = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL'] as const;
    const commercialCustomers = customers.filter((c) => c.isCommercial);
    for (let i = 0; i < 8; i++) {
      const cust = commercialCustomers[i % commercialCustomers.length];
      const planId = randomUUID();
      const cadence = pick(CADENCES);
      const startDate = daysAgo(randInt(30, 180));
      const endDate = daysFromNow(365 - randInt(0, 60));
      const annualPrice = round2(randInt(1200, 6000));
      planRows.push({
        id: planId,
        service_plan_number: fmt(org.service_plan_prefix, spNum++),
        customer_id: cust.id,
        service_location_id: cust.primaryLocationId,
        name: PLAN_NAMES[i % PLAN_NAMES.length],
        status: 'ACTIVE',
        visit_cadence: cadence as any,
        start_date: startDate,
        end_date: endDate,
        contract_price: annualPrice,
        sold_by: pick(leadOwners).id,
        organization_id: orgId,
        created_at: startDate,
        updated_at: startDate,
      });
      // line items
      const planLines = buildLines(randInt(2, 3)).items;
      planLines.forEach(([name, qty, price], idx) => {
        planLineRows.push({
          id: randomUUID(),
          service_plan_id: planId,
          name,
          quantity: qty,
          unit_price: price,
          position: idx + 1,
          organization_id: orgId,
        });
      });
      // upcoming + past visits
      const visitGapDays = cadence === 'MONTHLY' ? 30 : cadence === 'QUARTERLY' ? 90 : 182;
      let vn = 1;
      // a couple of completed past visits
      for (let v = 2; v >= 1; v--) {
        planVisitRows.push({
          id: randomUUID(),
          organization_id: orgId,
          service_plan_id: planId,
          visit_number: vn++,
          scheduled_date: daysAgo(v * visitGapDays - randInt(0, 5)),
          status: 'COMPLETED',
          completed_at: daysAgo(v * visitGapDays - randInt(0, 5)),
        });
      }
      // upcoming visits
      for (let v = 1; v <= 2; v++) {
        planVisitRows.push({
          id: randomUUID(),
          organization_id: orgId,
          service_plan_id: planId,
          visit_number: vn++,
          scheduled_date: daysFromNow(v * visitGapDays - randInt(0, 5)),
          status: 'SCHEDULED',
        });
      }
    }

    // 3h. TIMELINE (~40 recent) across entities → activity feed.
    const recentJobs = jobs.filter((j) => j.completedAt && j.completedAt > daysAgo(20)).slice(0, 15);
    const recentLeadRows = leadRows.slice(-15);
    const recentInvoices = invoices.slice(-10);
    function tl(entityType: string, entityId: string, eventType: string, description: string, createdAt: Date) {
      timelineRows.push({
        id: randomUUID(),
        entity_type: entityType,
        entity_id: entityId,
        event_type: eventType,
        description,
        created_by: pick(users).id,
        organization_id: orgId,
        created_at: createdAt,
      });
    }
    for (const j of recentJobs) {
      tl('JOB', j.id, 'job_completed', `Job completed and ready to invoice`, j.completedAt!);
    }
    for (const l of recentLeadRows) {
      tl('LEAD', l.id as string, 'lead_created', `New lead captured from ${l.source}`, l.created_at as Date);
    }
    for (const inv of recentInvoices) {
      tl('INVOICE', inv.id, inv.status === 'PAID' ? 'payment_recorded' : 'invoice_sent',
        inv.status === 'PAID' ? `Payment received` : `Invoice sent to customer`, inv.createdAt);
    }

    // ── 4. BULK INSERT (FK-safe parent→child order, chunked, sequential) ────
    async function insertChunked<T>(label: string, rows: T[], fn: (data: T[]) => Promise<unknown>) {
      if (rows.length === 0) {
        console.log(`  ${label}: 0`);
        return;
      }
      for (let i = 0; i < rows.length; i += CHUNK) {
        await fn(rows.slice(i, i + CHUNK));
      }
      console.log(`  ${label}: ${rows.length}`);
    }

    // ─── Lead stage clocks (spec #1751 D2/D3/D10) ─────────────────────────────────────────────
    //
    // Derived here rather than stamped at each `addLead`, because every fact these clocks are
    // made of is created AFTER the lead row: the visit when a walkthrough is booked, the estimate
    // when one is sent or approved. Every array is fully built by this point, so one pass over
    // them is both the simplest way to do it and the closest mirror of D10's backfill, which
    // derives the same five values from the same two tables.
    //
    // It matters that the seeder does this at all. A seeded org whose leads carry visits and
    // estimates but null clocks would misrepresent every one of them to anything that reads the
    // stage clocks - the automation anchors included - so the demo data has to agree with the
    // history it invents.
    {
      type Agg = {
        firstBooked?: Date; firstCompleted?: Date; lastCompleted?: Date;
        firstSent?: Date; firstApproved?: Date;
      };
      const byLead = new Map<string, Agg>();
      const at = (leadId: string) => {
        let a = byLead.get(leadId);
        if (!a) { a = {}; byLead.set(leadId, a); }
        return a;
      };
      const earlier = (cur: Date | undefined, next: Date) => (!cur || next < cur ? next : cur);
      const later = (cur: Date | undefined, next: Date) => (!cur || next > cur ? next : cur);

      for (const v of walkthroughRows) {
        if (!v.lead_id) continue;
        const a = at(v.lead_id as string);
        // No status filter, matching both the live door and the backfill: booking happened even
        // if the trip was later cancelled, and the clock is monotonic.
        if (v.created_at) a.firstBooked = earlier(a.firstBooked, v.created_at as Date);
        if (v.completed_at && v.status !== 'CANCELLED') {
          a.firstCompleted = earlier(a.firstCompleted, v.completed_at as Date);
          a.lastCompleted = later(a.lastCompleted, v.completed_at as Date);
        }
      }
      for (const e of estimateRows) {
        if (!e.lead_id) continue;
        const a = at(e.lead_id as string);
        if (e.sent_at) a.firstSent = earlier(a.firstSent, e.sent_at as Date);
        if (e.approved_at) a.firstApproved = earlier(a.firstApproved, e.approved_at as Date);
      }

      for (const l of leadRows) {
        const a = byLead.get(l.id as string);
        if (!a) continue;
        l.walkthrough_first_booked_at = a.firstBooked ?? null;
        l.walkthrough_first_completed_at = a.firstCompleted ?? null;
        l.last_visit_completed_at = a.lastCompleted ?? null;
        l.first_estimate_sent_at = a.firstSent ?? null;
        // Only a won lead has a won_at, exactly as in the backfill: an approved estimate under a
        // lead in some other status is not a win.
        l.won_at = l.status === 'WON' ? (a.firstApproved ?? null) : null;
      }
    }

    console.log('Inserting dataset…');
    await insertChunked('customers', customerRows, (d) => prisma.customer.createMany({ data: d }));
    await insertChunked('customer_emails', emailRows, (d) => prisma.customerEmail.createMany({ data: d }));
    await insertChunked('customer_phones', phoneRows, (d) => prisma.customerPhone.createMany({ data: d }));
    await insertChunked('service_locations', locationRows, (d) => prisma.serviceLocation.createMany({ data: d }));
    await insertChunked('leads', leadRows, (d) => prisma.lead.createMany({ data: d }));
    await insertChunked('lead_assignees', leadAssigneeRows, (d) => prisma.leadAssignee.createMany({ data: d }));
    await insertChunked('visits', walkthroughRows, (d) => prisma.visit.createMany({ data: d }));
    await insertChunked('lead_walkthrough_performers', walkPerformerRows, (d) => prisma.visitAssignee.createMany({ data: d }));
    await insertChunked('estimates', estimateRows, (d) => prisma.estimate.createMany({ data: d }));
    await insertChunked('estimate_line_items', estLineRows, (d) => prisma.estimateLineItem.createMany({ data: d }));
    await insertChunked('service_plans', planRows, (d) => prisma.servicePlan.createMany({ data: d }));
    await insertChunked('service_plan_line_items', planLineRows, (d) => prisma.servicePlanLineItem.createMany({ data: d }));
    await insertChunked('jobs', jobRows, (d) => prisma.job.createMany({ data: d }));
    // S8 (D6): AFTER jobs - a visit's job_id is an FK.
    await insertChunked('job visits', jobVisitRows, (d) => prisma.visit.createMany({ data: d }));
    await insertChunked('job visit crew', jobVisitCrewRows, (d) => prisma.visitAssignee.createMany({ data: d }));
    await insertChunked('plan_visits', planVisitRows, (d) => prisma.planVisit.createMany({ data: d }));
    await insertChunked('invoices', invoiceRows, (d) => prisma.invoice.createMany({ data: d }));
    await insertChunked('invoice_line_items', invLineRows, (d) => prisma.invoiceLineItem.createMany({ data: d }));
    await insertChunked('payments', paymentRows, (d) => prisma.payment.createMany({ data: d }));
    await insertChunked('timeline_events', timelineRows, (d) => prisma.timelineEvent.createMany({ data: d }));

    // ── 5. Numbering counters: bump to max+1 for tidiness (allocateNumber self-heals anyway). ──
    await prisma.organization.update({
      where: { id: orgId },
      data: {
        customer_next_number: custNum,
        lead_next_number: leadNum,
        estimate_next_number: estNum,
        job_next_number: jobNum,
        invoice_next_number: invNum,
        service_plan_next_number: spNum,
      },
    });

    // ── 6. AppSetting: revenue_target_monthly ──────────────────────────────
    await prisma.appSetting.upsert({
      where: { organization_id_key: { organization_id: orgId, key: 'revenue_target_monthly' } },
      update: { value: '65000' },
      create: { organization_id: orgId, key: 'revenue_target_monthly', value: '65000' },
    });

    console.log('\nDone. Seed complete.\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
