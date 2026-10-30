/* =============================================================================
   Roles & Permissions security fixes, H6 (ticket 34): every money column is decided.

   The price filter (lib/permissions/prices.ts) leaves a field out of an answer by its NAME, so a money column whose name
   is on no list reaches a person without See prices the day it ships. This guard reads the database schema, lists every
   money column, and fails until each one is decided:
     - covered by the price filter: its name is a price key everywhere, or a name the rule of every address listed for it
       makes money (checked against the filter itself, so the claim cannot drift from the rules);
     - covered by the cost rules (M4, ticket 35): its name is a cost key everywhere, or a name the rule of every address
       listed for it makes a cost - checked against the filter itself, the same way;
     - on a reasoned allow-list: not a price (a quantity, a percentage, a setting), or a company figure that its own
       switch (See company figures) leaves out.
   Adding to the allow-list is a decision made in review, not a way to make this test pass.

   What counts as a money column: a number column (Decimal, Int, BigInt, Float) that is either a Decimal (money is
   stored as Decimal in this schema) or whose name holds a money word (price, amount, total, cost, balance, fee, tax,
   deposit, tip, paid, due, revenue, cents, rate, markup, ...). A number named like money but holding a count still has
   to be decided, which is the point: the guard cannot tell a count from money, a person can.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isCostField, isPriceField } from '../lib/permissions/prices';

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

const NUMBER_TYPES = new Set(['Decimal', 'Int', 'BigInt', 'Float']);
const MONEY_WORDS = new Set([
  'price', 'prices', 'amount', 'amounts', 'total', 'totals', 'subtotal', 'cost', 'costs', 'balance', 'fee', 'fees', 'tax',
  'deposit', 'tip', 'paid', 'due', 'owed', 'refund', 'refunded', 'credit', 'credits', 'discount', 'revenue', 'collected',
  'invoiced', 'payout', 'cents', 'value', 'rate', 'margin', 'markup', 'overhead', 'wage', 'salary', 'budget', 'charge',
  'charged', 'net', 'bps',
]);

/** Every money column of a schema, as `Model.field`. */
function moneyColumns(schema: string): string[] {
  const out: string[] = [];
  let model: string | null = null;
  for (const line of schema.split('\n')) {
    const opens = /^model (\w+) \{/.exec(line);
    if (opens) { model = opens[1]!; continue; }
    if (line.startsWith('}')) { model = null; continue; }
    if (!model) continue;
    const field = /^\s+(\w+)\s+(\w+)(\?|\[\])?\s/.exec(`${line} `);
    if (!field || !NUMBER_TYPES.has(field[2]!)) continue;
    const words = field[1]!.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split('_');
    if (field[2] === 'Decimal' || words.some((w) => MONEY_WORDS.has(w))) out.push(`${model}.${field[1]}`);
  }
  return out;
}

const fieldOf = (column: string) => column.split('.')[1]!;

/**
 * Money only on some routes: a generic name (`amount`) the filter leaves out by the rule of the address that answers with
 * it. Each lists the addresses known to answer with the column; every one must be covered by the filter's rule for it. A
 * new address that answers with one of these must be added here AND get a rule in prices.ts.
 */
const PRICE_ON_ROUTES: Record<string, readonly string[]> = {
  'Payment.amount': [
    '/api/invoices/x', '/api/estimates/x', '/api/jobs/x/financials', '/api/customers/x', '/api/payments-page/payments',
    '/api/payments-needing-attention', '/api/reports/payments',
  ],
  'Refund.amount': ['/api/invoices/x', '/api/payments-page/payments/x'],
  'Credit.amount': ['/api/invoices/x'],
  'DepositCreditApplication.amount': ['/api/invoices/x'],
  'Payout.amount': ['/api/payments-page/payouts'],
  'Dispute.amount': ['/api/payments-page/payments/x'],
  'UnappliedCapture.amount': ['/api/payments-needing-attention', '/api/payments-page/payments'],
  'ScopePreset.price': ['/api/scope-presets'],
};

/** Money that is a cost only on some routes (the cost twin of PRICE_ON_ROUTES). */
const COST_ON_ROUTES: Record<string, readonly string[]> = {
  'RfqQuote.total': ['/api/inventory/rfqs', '/api/inventory/rfqs/x'],
};

const QUANTITY = 'a quantity of items, not money';
const PERCENTAGE = 'a percentage, not an amount: the amount it yields is the price (tax_amount, deposit_amount)';

/** Not a price, or a company figure that its own switch leaves out. Each says why. */
const NOT_A_PRICE: Record<string, string> = {
  'EstimateLineItem.quantity': QUANTITY,
  'InvoiceLineItem.quantity': QUANTITY,
  'JobLineItem.quantity': QUANTITY,
  'ServicePlanMaterialLine.qty': QUANTITY,
  'StockBalance.on_hand': QUANTITY,
  'StockBalance.reserved': QUANTITY,
  'StockMovement.qty': QUANTITY,
  'PurchaseOrderLine.qty_ordered': QUANTITY,
  'PurchaseOrderLine.qty_received': QUANTITY,
  'RfqLine.qty': QUANTITY,
  'ReservationLine.qty': QUANTITY,
  'JobStageLine.qty_ordered': QUANTITY,
  'JobStageLine.qty_received': QUANTITY,
  'StockApproval.qty': QUANTITY,
  'ItemGroupLine.quantity': QUANTITY,
  'LogisticOrderLine.qty': QUANTITY,
  'Estimate.tax_rate': PERCENTAGE,
  'Job.tax_rate': PERCENTAGE,
  'Invoice.tax_rate': PERCENTAGE,
  'StateTaxRate.tax_rate': `${PERCENTAGE}; the public tax table of a state`,
  'OrgTaxRate.rate': `${PERCENTAGE}; the company's tax table`,
  'Organization.deposit_default_percentage': `${PERCENTAGE}; the company's default deposit as a share (the fixed amount is a price key)`,
  'Organization.tip_presets': 'the tip percentages offered to the customer, a company setting',
  'Organization.platform_fee_bps': 'the service fee rate on the company\'s plan, in basis points; a setting, not a price on a record',
  'TermsAcceptance.disclosed_fee_bps': 'the fee rate shown when the company accepted the terms, in basis points; a record of consent',
  'PhoneAgent.answer_rate_pct': 'a percentage of calls answered, not money',
  'PhoneAgent.booking_rate_pct': 'a percentage of calls booked, not money',
  'SpiderAlert.limit_value': 'an alert threshold (minutes or a count), not money',
  'SpiderAlert.elapsed_value': 'how far past the threshold an alert is (minutes or a count), not money',
  'CallSession.revenue': 'a company figure: comm-calls.controller leaves it out without See company figures (which needs See prices)',
  'PhoneAgent.revenue': 'a company figure: comm-agents.controller leaves it out without See company figures (which needs See prices)',
};

/** Money columns of a schema that are not decided: not covered by the price rules, not by the cost rules, not allowed. */
function undecided(schema: string): string[] {
  return moneyColumns(schema).filter((column) => {
    if (isPriceField('/api', fieldOf(column))) return false;
    if (isCostField('/api', fieldOf(column))) return false;
    const priceRoutes = PRICE_ON_ROUTES[column];
    if (priceRoutes) return !priceRoutes.every((address) => isPriceField(address, fieldOf(column)));
    const costRoutes = COST_ON_ROUTES[column];
    if (costRoutes) return !costRoutes.every((address) => isCostField(address, fieldOf(column)));
    return !(column in NOT_A_PRICE);
  });
}

describe('every money column is covered by the price rules, the cost rules, or is allowed with a reason (guard)', () => {
  it('finds the money columns it is meant to find', () => {
    const columns = moneyColumns(SCHEMA);
    // A sample of known money columns, by type and by name.
    for (const known of ['Invoice.total_amount', 'Payment.amount', 'PriceBookItem.unit_cost', 'Organization.platform_fee_bps']) {
      expect(columns).toContain(known);
    }
    // A number that is not named like money and is not a Decimal is not one.
    expect(columns).not.toContain('Dispute.evidence_version');
  });

  it('has no money column left undecided', () => {
    expect(undecided(SCHEMA)).toEqual([]);
  });

  it('fails on a new money column nobody decided, by type or by name', () => {
    const added = `${SCHEMA}\nmodel GuardProbe {\n  id String @id\n  surcharge Decimal @db.Decimal(12, 2)\n  late_fee_cents Int\n  visit_count Int\n}\n`;
    expect(undecided(added)).toEqual(['GuardProbe.surcharge', 'GuardProbe.late_fee_cents']);
  });

  it('fails when a column claimed for a route is not covered by that route\'s rule', () => {
    const added = `${SCHEMA}\nmodel Payment2 {\n  id String @id\n  amount Decimal @db.Decimal(12, 2)\n}\n`;
    // An `amount` on a model nobody listed is not covered: `amount` is money only by the rule of a route.
    expect(undecided(added)).toEqual(['Payment2.amount']);
  });

  it('lists no column that is gone from the schema, and decides each column once', () => {
    const columns = new Set(moneyColumns(SCHEMA));
    const listed = [...Object.keys(PRICE_ON_ROUTES), ...Object.keys(COST_ON_ROUTES), ...Object.keys(NOT_A_PRICE)];
    expect(listed.filter((c) => !columns.has(c))).toEqual([]);
    expect(listed.filter((c, i) => listed.indexOf(c) !== i)).toEqual([]);
    // A column a filter already covers by name needs no entry anywhere.
    expect(listed.filter((c) => isPriceField('/api', fieldOf(c)) || isCostField('/api', fieldOf(c)))).toEqual([]);
  });

  it('covers a cost column by its name, and the three prices of ticket 35 under the price rules', () => {
    const columns = moneyColumns(SCHEMA);
    for (const cost of ['PriceBookItem.unit_cost', 'EstimateLineItem.markup_percent', 'Job.labor_hours', 'Organization.labor_rate', 'Brand.default_markup_pct', 'ScopePreset.internal_cost']) {
      expect(columns).toContain(cost);
      expect(isCostField('/api', fieldOf(cost)), cost).toBe(true);
      expect(isPriceField('/api', fieldOf(cost)), cost).toBe(false);
    }
    for (const price of ['ServicePlan.contract_price', 'ServicePlanTemplate.default_price']) {
      expect(columns).toContain(price);
      expect(isPriceField('/api', fieldOf(price)), price).toBe(true);
      expect(isCostField('/api', fieldOf(price)), price).toBe(false);
    }
    expect(isPriceField('/api/scope-presets', 'price')).toBe(true);
    expect(isCostField('/api/inventory/rfqs/x', 'total')).toBe(true);
    // `total` is a cost on the vendor-quote routes only.
    expect(isCostField('/api/invoices', 'total')).toBe(false);
  });
});
