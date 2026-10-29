import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * US sales tax rates as a fraction, from Tax Foundation "State and Local Sales Tax Rates"
 * (https://taxfoundation.org/data/all/state/sales-tax-rates/), figures as of 2026-01-01.
 *
 * WHICH COLUMN, AND WHY IT CHANGED (Ran's call, 2026-08-04: "take the highest value, i.e. 8.54%
 * for NY"). This array holds the **Combined State & Average Local Sales Tax Rate**, superseding
 * the state-only definition #1208 established. A contractor billing a job in Brooklyn charges the
 * combined rate, not New York's 4.00% state slice, so the state-only figure was never the number
 * a line item needed - it merely looked authoritative because the column is keyed by state.
 *
 * WHAT THAT COSTS, STATED PLAINLY: local rates are AVERAGED across each state, so no row here is
 * the legally exact rate for any one address. This table is a sane default, not a tax engine. An
 * org that knows its real combined rate defines a custom OrgTaxRate (Settings > Custom Tax Rates,
 * or "+ Add tax rate" straight from any tax dropdown) and picks that instead.
 *
 * NJ is the one state where combined (6.60%) sits BELOW the state rate (6.625%): its Urban
 * Enterprise Zones charge half rate, dragging the local average negative. That is the source
 * table's own figure, not a typo.
 *
 * PRECISION (kept from #1208, still binding): the column is DECIMAL(6,5), so a rate may carry up
 * to five decimal places as a fraction. Never round a rate to make it fit - rounding a
 * half-basis-point rate moves it upward, i.e. overcharges. `state-tax-rates.test.ts` pins this.
 *
 * Kept in lockstep with migrations/20260804120000_state_tax_rates_2026 - update both together.
 */
export const STATE_TAX_RATES = [
  { state_code: 'AL', state_name: 'Alabama', tax_rate: 0.09460 },
  { state_code: 'AK', state_name: 'Alaska', tax_rate: 0.01820 },
  { state_code: 'AZ', state_name: 'Arizona', tax_rate: 0.08520 },
  { state_code: 'AR', state_name: 'Arkansas', tax_rate: 0.09460 },
  { state_code: 'CA', state_name: 'California', tax_rate: 0.08990 },
  { state_code: 'CO', state_name: 'Colorado', tax_rate: 0.07890 },
  { state_code: 'CT', state_name: 'Connecticut', tax_rate: 0.06350 },
  { state_code: 'DE', state_name: 'Delaware', tax_rate: 0.00000 },
  { state_code: 'DC', state_name: 'District of Columbia', tax_rate: 0.06000 },
  { state_code: 'FL', state_name: 'Florida', tax_rate: 0.06980 },
  { state_code: 'GA', state_name: 'Georgia', tax_rate: 0.07490 },
  { state_code: 'HI', state_name: 'Hawaii', tax_rate: 0.04500 },
  { state_code: 'ID', state_name: 'Idaho', tax_rate: 0.06030 },
  { state_code: 'IL', state_name: 'Illinois', tax_rate: 0.08960 },
  { state_code: 'IN', state_name: 'Indiana', tax_rate: 0.07000 },
  { state_code: 'IA', state_name: 'Iowa', tax_rate: 0.06940 },
  { state_code: 'KS', state_name: 'Kansas', tax_rate: 0.08690 },
  { state_code: 'KY', state_name: 'Kentucky', tax_rate: 0.06000 },
  { state_code: 'LA', state_name: 'Louisiana', tax_rate: 0.10110 },
  { state_code: 'ME', state_name: 'Maine', tax_rate: 0.05500 },
  { state_code: 'MD', state_name: 'Maryland', tax_rate: 0.06000 },
  { state_code: 'MA', state_name: 'Massachusetts', tax_rate: 0.06250 },
  { state_code: 'MI', state_name: 'Michigan', tax_rate: 0.06000 },
  { state_code: 'MN', state_name: 'Minnesota', tax_rate: 0.08140 },
  { state_code: 'MS', state_name: 'Mississippi', tax_rate: 0.07060 },
  { state_code: 'MO', state_name: 'Missouri', tax_rate: 0.08440 },
  { state_code: 'MT', state_name: 'Montana', tax_rate: 0.00000 },
  { state_code: 'NE', state_name: 'Nebraska', tax_rate: 0.06980 },
  { state_code: 'NV', state_name: 'Nevada', tax_rate: 0.08240 },
  { state_code: 'NH', state_name: 'New Hampshire', tax_rate: 0.00000 },
  { state_code: 'NJ', state_name: 'New Jersey', tax_rate: 0.06600 },
  { state_code: 'NM', state_name: 'New Mexico', tax_rate: 0.07670 },
  { state_code: 'NY', state_name: 'New York', tax_rate: 0.08540 },
  { state_code: 'NC', state_name: 'North Carolina', tax_rate: 0.07000 },
  { state_code: 'ND', state_name: 'North Dakota', tax_rate: 0.07090 },
  { state_code: 'OH', state_name: 'Ohio', tax_rate: 0.07290 },
  { state_code: 'OK', state_name: 'Oklahoma', tax_rate: 0.09060 },
  { state_code: 'OR', state_name: 'Oregon', tax_rate: 0.00000 },
  { state_code: 'PA', state_name: 'Pennsylvania', tax_rate: 0.06340 },
  { state_code: 'RI', state_name: 'Rhode Island', tax_rate: 0.07000 },
  { state_code: 'SC', state_name: 'South Carolina', tax_rate: 0.07490 },
  { state_code: 'SD', state_name: 'South Dakota', tax_rate: 0.06110 },
  { state_code: 'TN', state_name: 'Tennessee', tax_rate: 0.09610 },
  { state_code: 'TX', state_name: 'Texas', tax_rate: 0.08200 },
  { state_code: 'UT', state_name: 'Utah', tax_rate: 0.07420 },
  { state_code: 'VT', state_name: 'Vermont', tax_rate: 0.06390 },
  { state_code: 'VA', state_name: 'Virginia', tax_rate: 0.05770 },
  { state_code: 'WA', state_name: 'Washington', tax_rate: 0.09510 },
  { state_code: 'WV', state_name: 'West Virginia', tax_rate: 0.06590 },
  { state_code: 'WI', state_name: 'Wisconsin', tax_rate: 0.05720 },
  { state_code: 'WY', state_name: 'Wyoming', tax_rate: 0.05560 },
];

async function main() {
  console.log('Seeding state tax rates...');

  for (const rate of STATE_TAX_RATES) {
    await prisma.stateTaxRate.upsert({
      where: { state_code: rate.state_code },
      update: { state_name: rate.state_name, tax_rate: rate.tax_rate },
      create: rate,
    });
  }

  const count = await prisma.stateTaxRate.count();
  console.log(`Done - ${count} state tax rates in database.`);
}

// Only seed when run as a script (`npm run seed:tax-rates`). Importing this module - which
// state-tax-rates.test.ts does, to assert the rate table's precision - must not open a Prisma
// connection or write to whatever database the ambient env happens to point at.
if (process.argv[1] && process.argv[1].includes('seed-tax-rates')) {
  main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
