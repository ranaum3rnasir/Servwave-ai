import type { NextFunction, Request, Response } from 'express';
import parseurl from 'parseurl';
import { canSeePrices } from './enforce';

/**
 * P11 - the price class of the three money classes (prices, costs, company figures), enforced on the answer.
 *
 * A price is any money value a record carries for the customer: a line's unit price and total, a subtotal, a document
 * total, tax, a discount, a balance, a deposit, a payment amount, the price book's sell price, and every figure built
 * by summing them (a job's money panel, a customer's balance and lifetime revenue). A person without See prices
 * (`canSeePrices` in enforce.ts) gets none of them, in any list, page, export, picker or search result: the key is
 * LEFT OUT of the answer, never zero or null or masked, so a screen cannot mistake "hidden" for "nothing" (P11).
 *
 * It runs once, over every JSON answer a signed-in person receives, instead of at the dozens of controller sites that
 * build one. That is deliberate: every new endpoint that returned a record had to remember to strip, one by one; here a
 * record that carries a known price key is covered the day it ships. The COST class (M4, ticket 35) is stripped in this
 * same place, by the same walk, for a person without See costs: the controllers' own strips stay as a second line, and
 * the key lists below are the first. A feature that shows a
 * new money value adds its key to the class below (P11: it never adds a switch); a new money column in the schema fails
 * the money-column guard (__tests__/permission-money-columns-guard.test.ts) until it is covered here or decided there.
 *
 * What it never touches:
 *  - an answer to someone who is not signed in (the customer's own estimate page, invoice page and pay page keep their
 *    prices: a customer-facing page is not an output shown to a staff member);
 *  - counts, rates, dates, statuses and the money class of the company (see companyFigures.ts) or of costs (the cost
 *    sites in the controllers).
 */

const PRICE_KEYS_SNAKE = [
  // Documents and their lines.
  'subtotal', 'tax_amount', 'total_amount', 'discount_amount', 'discount_value', 'unit_price', 'line_total', 'flat_price',
  'deposit_value', 'deposit_amount', 'deposit_percentage', 'deposit_credit', 'deposit_required', 'amount_due', 'amount_invoiced', 'amount_paid',
  'amount_owed', 'owed_amount', 'money_owed', 'total_refunded', 'net_collected', 'tip',
  // The tax inside a refund or a credit; the total an estimate's reservation holds.
  'tax_portion', 'reserved_total',
  // What card payments have collected and the payout account has not paid out yet (the payout account status).
  'collected_awaiting_payout',
  // The company's default deposit as an amount: the deposit an estimate asks for when it names none (deposit-amount.ts).
  'deposit_default_fixed_amount',
  // Payments.
  'net_amount', 'tip_amount', 'stripe_fee_amount', 'platform_fee_amount', 'service_fee_amount', 'refunded_amount',
  'refundable_amount', 'charged_amount', 'invoice_amount', 'processing_amount', 'amount_processing',
  // What an invoice can take now (its balance less the bank money still clearing), on the payments drawer's invoice rows (N5);
  // a payout's gap between what ServWave added up and what was paid out (N11); a discounted line's full price before its
  // discount, on the estimate's document view and the frozen view a past estimate version carries (N10, `grossAmount`).
  'payable_now', 'net_difference', 'gross_amount',
  // The price book.
  'sell_price', 'list_price',
  // What a service plan sells for and what a plan template starts from (M4, ticket 35): prices, not costs.
  'contract_price', 'default_price',
  // An item group's prices: its flat rate and a line's own price.
  'flat_rate_price_override', 'price_override',
  // What a job and a customer sum.
  'total_invoiced', 'total_paid', 'collected_total', 'confirmed_amount', 'lifetime_revenue', 'past_due_balance', 'due_balance',
  // The record's field holding the customer's private link to their estimate or invoice page. That page opens with no
  // sign-in and shows every price, so the field is a price (H6). A link written inside a message is the message's words,
  // which this filter does not read (Ran, 2026-10-28).
  'public_token',
] as const;

/**
 * Keys that are a price wherever they appear in an answer, in the snake_case the records use and the camelCase the
 * inventory and payments controllers shape. Each is specific enough that no non-money field carries the name; a generic
 * name (`amount`, `value`, `total`) is handled by `ROUTE_RULES` for the routes where it is money.
 */
const PRICE_KEYS: ReadonlySet<string> = new Set([
  ...PRICE_KEYS_SNAKE,
  ...PRICE_KEYS_SNAKE.map((k) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())),
]);

/**
 * Names that are money only on some routes: `amount` on an invoice's payment, `value` in the estimate list's stats,
 * `total` in a search hit. `keys` leave out that name at any depth of the answer; `paths` leave out one place, written
 * from the answer's root with `*` for any one key (a list is transparent: `rows.amount` is the amount of each row).
 * A route that is nothing but money - a customer statement - is not here: it needs See prices to open at all.
 */
interface RouteRule {
  route: RegExp;
  keys?: readonly string[];
  paths?: readonly string[];
  /**
   * The answer carries history entries whose `metadata` holds the entry's figures under whatever key its writer chose
   * (`amount`, `charged_cents`, `unapplied_cents`, `disputed_cents`, ...). Every key under a `metadata` object that
   * `isMoneyMetadataKey` calls money is left out, so a writer that adds a new figure under a name that reads as money is
   * covered the day it ships, with no list to remember to extend.
   */
  metadataMoney?: boolean;
}

const ROUTE_RULES: readonly RouteRule[] = [
  // Estimates: the list's stats carry the value of each status and the deposits still to collect.
  { route: /^\/api\/estimates$/, paths: ['stats.*.value', 'stats.pending_deposits.total'] },
  { route: /^\/api\/estimates\/stats$/, paths: ['*.value', 'pending_deposits.total'] },
  // Estimates: a payment on the deposit invoice the detail carries, and what recording or waiving a deposit answers.
  { route: /^\/api\/estimates(?:\/|$)/, keys: ['amount'] },
  // Invoices: payments, refunds, credits and deposit credits all say `amount`; the list's stats sum them.
  { route: /^\/api\/invoices(?:\/|$)/, keys: ['amount', 'balance'] },
  // The payment-link answer's `url` field is the customer's private link, token and all (H6).
  { route: /^\/api\/invoices\/[^/]+\/payment-link$/, keys: ['url'] },
  { route: /^\/api\/invoices$/, paths: ['stats.due.total', 'stats.overdue.total', 'stats.collected_this_month.total', 'stats.deposits_held'] },
  // Jobs: the money panel, the billing preview that rides on every line answer, and a job's payments.
  { route: /^\/api\/jobs(?:\/|$)/, keys: ['amount', 'billing', 'totals', 'remaining_unbilled', 'balance'] },
  // Customers: the payments under their invoices, the deposits collected, the value of their estimates. The page and its
  // summary also carry the deposits still to collect (`pending`: a COUNT on `estimates`, money on `deposits`, so by path).
  {
    route: /^\/api\/customers(?:\/|$)/,
    keys: ['amount', 'collected', 'total_value'],
    paths: ['summary.deposits.pending', 'deposits.pending'],
  },
  // The estimate price presets: `price` is the preset's price (its cost, `internal_cost`, is a cost key).
  { route: /^\/api\/scope-presets(?:\/|$)/, keys: ['price'] },
  // Search: an estimate or invoice hit shows its total.
  { route: /^\/api\/search$/, paths: ['results.estimates.total', 'results.invoices.total'] },
  // Reports: a row of a report is a record, so its amounts are prices; a report's own totals are company figures.
  { route: /^\/api\/reports(?:\/|$)/, keys: ['amount', 'billed', 'paid', 'due', 'depositDue', 'balance', 'tax', 'value'] },
  // The dashboard: the money tiles are not offered without See prices; what is left is a scoreboard's revenue column, an
  // amount on a row of a list, and the total of an estimate still to send.
  { route: /^\/api\/dashboard$/, keys: ['revenue', 'amount'], paths: ['data.estimates_to_send.estimates.total'] },
  // The history of a record: its entries carry the figure in `metadata.amount` (and the from/to of a change). The words of an entry
  // ("Payment received via card") name no figure, and no text is ever scanned (Ran, 2026-10-28).
  {
    route: /^\/api\/(?:invoices|estimates|jobs|leads|customers)\/[^/]+\/(?:timeline|history)$/,
    keys: ['amount', 'from_amount', 'to_amount'],
    metadataMoney: true,
  },
  // The Payments page is nothing but payment amounts. An unapplied payment's drawer also names the invoice it was meant for, with
  // that invoice's total, and lists invoices it could go on with each one's balance (N5).
  {
    route: /^\/api\/payments-(?:page|needing-attention)(?:\/|$)/,
    keys: [
      'amount', 'collected', 'fee', 'fees', 'net', 'refunded', 'refunds', 'in_transit', 'service_fee', 'platform_fee', 'paid_face_cents', 'tip_cents',
      'balance',
    ],
    paths: ['meant_for.invoice.total'],
  },
];

/**
 * The COST class: what the company pays or assumes, never shown to the customer - a line's unit cost and markup, the
 * labor-hours / overhead cost model of a document and of the company, a preset's internal cost, a price book group line's
 * cost, a brand's default markup. A person without See costs (`canSeeCosts` in enforce.ts, the `read Pricing` grant) gets
 * none of them, in any list, page, export, picker or search result: the key is left out, never zero or null (P11).
 * Each name is specific enough that no other field carries it; a generic name (`total` on a vendor's quote) is handled by
 * `COST_ROUTE_RULES` for the routes where it is a cost.
 */
const COST_KEYS_SNAKE = [
  'unit_cost', 'markup_percent', 'internal_cost', 'cost_override', 'default_markup_pct',
  'labor_hours', 'labor_rate', 'overhead_mode', 'overhead_value',
] as const;

const COST_KEYS: ReadonlySet<string> = new Set([
  ...COST_KEYS_SNAKE,
  ...COST_KEYS_SNAKE.map((k) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())),
]);

/**
 * Names that are a cost only on some routes. A vendor's quote on a request for quotes says `total`: money the company
 * would pay. (The RFQ routes are parked today - they answer 404 - so this is in place for the day they are un-parked.)
 */
const COST_ROUTE_RULES: readonly RouteRule[] = [
  { route: /^\/api\/inventory\/rfqs(?:\/|$)/, keys: ['total'] },
];

type Json = Record<string, unknown>;

/**
 * Whether a key inside a history entry's `metadata` holds a figure. One rule for every writer: the key names an amount, cents, a
 * balance, a total, a price, a fee, a tip, what is owed or due, or an overpayment (`charged_cents`, `unapplied_cents`, `disputed_cents`, `amount_due`, `overpaid`) - as a whole word, so `payment_id` and
 * `reason` are never caught. A date or a reference that happens to carry such a word (`due_date`, `amount_id`) is not money.
 * The metadata guard (permission-costs-central.test.ts) reads every key the history writers store against a wider list of
 * money words, so a figure under a name this does not call money fails the build.
 */
export function isMoneyMetadataKey(key: string): boolean {
  if (PRICE_KEYS.has(key)) return true;
  const k = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (/(?:_at|_id|_ids|_by|_date|_key|_label|_number|_type|_status|_method|_reason|_category)$/.test(k)) return false;
  return /(?:^|_)(?:amount|amounts|cents|overpaid|balance|total|price|fee|fees|tip|owed|due)(?:_|$)/.test(k);
}

const isPlain = (v: unknown): v is Json => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** True when the dotted path from the root matches a rule path (`*` is any one key). */
function pathMatches(pattern: readonly string[], path: readonly string[]): boolean {
  return pattern.length === path.length && pattern.every((step, i) => step === '*' || step === path[i]);
}

/**
 * A copy of an answer with every price key left out at any depth. Dates, Decimals and the like pass through whole. `rules`
 * are the extra names for the route the answer is for.
 */
export function omitPrices<T>(value: T, rules: Rules = NO_RULES): T {
  return omitKeys(value, PRICE_KEYS, rules);
}

/** The same walk for the cost class: every cost key left out at any depth, plus the names the address's rule makes costs. */
export function omitCosts<T>(value: T, rules: Rules = NO_RULES): T {
  return omitKeys(value, COST_KEYS, rules);
}

function omitKeys<T>(value: T, base: ReadonlySet<string>, rules: Rules): T {
  const walk = (node: unknown, path: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, path));
    if (!isPlain(node)) return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (base.has(k) || rules.keys.has(k)) continue;
      if (rules.metadataMoney && path.includes('metadata') && isMoneyMetadataKey(k)) continue;
      const here = [...path, k];
      if (rules.paths.some((p) => pathMatches(p, here))) continue;
      out[k] = walk(v, here);
    }
    return out;
  };
  return walk(value, []) as T;
}

interface Rules {
  keys: ReadonlySet<string>;
  paths: ReadonlyArray<readonly string[]>;
  metadataMoney: boolean;
}
const NO_RULES: Rules = { keys: new Set<string>(), paths: [], metadataMoney: false };

/**
 * The address as the router reads it, so a rule matches the route and not the raw text (H6, story 51: "however the address
 * is written"). The path is taken by the very parser the router uses (`parseurl`, which Express's router calls on every
 * request), so the two can never disagree: a plain path is read as written, while a path with a "#", or a request line
 * that carries the whole address ("GET http://host/api/invoices/1", "GET foo://h/api\invoices/1"), is read the lenient way,
 * which turns "\" into "/". The router then matches without regard to case, a trailing "/" or a doubled "/", so those are
 * tidied here too: `/API/Invoices/` reaches the same handler as `/api/invoices`, and `/api/estimates//stats` the same as
 * `/api/estimates/stats`.
 */
function routeOf(originalUrl: string | undefined): string {
  const path = parseurl.original({ originalUrl: originalUrl ?? '' })?.pathname ?? '';
  return path.toLowerCase().replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
}

/** The extra names that apply to an address. */
function rulesFor(originalUrl: string | undefined, table: readonly RouteRule[] = ROUTE_RULES): Rules {
  const route = routeOf(originalUrl);
  const keys = new Set<string>();
  const paths: Array<readonly string[]> = [];
  let metadataMoney = false;
  for (const rule of table) {
    if (!rule.route.test(route)) continue;
    for (const k of rule.keys ?? []) keys.add(k);
    for (const p of rule.paths ?? []) paths.push(p.split('.'));
    if (rule.metadataMoney) metadataMoney = true;
  }
  return { keys, paths, metadataMoney };
}

/**
 * Whether the filter leaves a field of this name out of an answer to this address for a person without See prices: a
 * price key anywhere, or a name the address's own rule makes money. The money-column guard reads it to prove every money
 * column of the schema is covered.
 */
export function isPriceField(address: string, key: string): boolean {
  return PRICE_KEYS.has(key) || rulesFor(address).keys.has(key);
}

/**
 * The bell carries no amount for anyone (Ran, 2026-10-28): an alert's data bag is stored and shown without any money field. A bell
 * names the event ("Refund issued for INV-1"), never the figure; the figure is on the invoice, for whoever may open it. This is the
 * one place that says which keys of that bag are money: `amount` (the alerts' own name for it) and every price or cost key.
 * Message text is NOT touched here or anywhere in the bell: a customer's "$500" in a text preview stays as they wrote it.
 */
export function withoutMoneyFields<T extends Record<string, unknown>>(data: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (k !== 'amount' && !PRICE_KEYS.has(k) && !COST_KEYS.has(k)) out[k] = v;
  return out as T;
}

/**
 * Whether the filter leaves a field of this name out of an answer to this address for a person without See costs: a cost
 * key anywhere, or a name the address's own rule makes a cost. The money-column guard reads it, as it reads `isPriceField`.
 */
export function isCostField(address: string, key: string): boolean {
  return COST_KEYS.has(key) || rulesFor(address, COST_ROUTE_RULES).keys.has(key);
}

/**
 * Express middleware, mounted ahead of the API routers. It wraps `res.json`, so the decision is taken when the
 * answer is sent, after the route has authenticated the person and loaded their ability. A request with no signed-in
 * person, or one whose ability the route never loaded (so it checks nothing), is left alone.
 */
export function omitPricesFromAnswers(req: Request, res: Response, next: NextFunction): void {
  const send = res.json.bind(res);
  res.json = (body?: unknown): Response => {
    if (!req.user || !req.ability) return send(body);
    let out = body;
    if (!req.ability.can('read', 'Prices' as never)) out = omitPrices(out, rulesFor(req.originalUrl));
    if (!req.ability.can('read', 'Pricing' as never)) out = omitCosts(out, rulesFor(req.originalUrl, COST_ROUTE_RULES));
    return send(out);
  };
  next();
}

/**
 * Sorting by a price, and filtering by a price range, tell a person what the price is without ever showing it (sort by
 * total and the order gives the ranking; narrow the range and the count gives the figure). For a person without See prices
 * a list or export ignores them: it answers in its default order and without that filter, the same as if the screen had
 * never offered them.
 */
const PRICE_SORT_IDS = new Set(['total', 'total_amount', 'amount_due', 'unit_price', 'amount', 'fee', 'net']);
const PRICE_FILTER_PARAMS = ['total_min', 'total_max', 'balance_min', 'balance_max', 'amount_min', 'amount_max'];

export function ignorePriceQuery(req: Request): void {
  if (canSeePrices(req)) return;
  const query = req.query as Record<string, unknown>;
  if (typeof query.sortBy === 'string' && PRICE_SORT_IDS.has(query.sortBy)) {
    delete query.sortBy;
    delete query.sortDir;
  }
  for (const param of PRICE_FILTER_PARAMS) delete query[param];
}
