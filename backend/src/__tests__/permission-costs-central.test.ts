/* =============================================================================
   Roles & Permissions security fixes, M4 (ticket 35): costs are hidden in the same central place as prices.

   No database. This file proves the central filter itself and the guards that make a new mistake fail the build:
     - the filter, as the app mounts it (`omitPricesFromAnswers`): for a person with neither switch, with See prices only,
       and with See prices and See costs, a payload carrying every cost key and price key comes back with exactly what the
       switches allow; the cost keys travel in snake_case and camelCase, at any depth;
     - the names that are money only on some routes (a preset's `price`, a vendor quote's `total`, a
       customer's pending deposits) are hidden on those routes and ONLY there;
     - the merge-field guard: every merge field an automation advertises, and every one the context builder sets, that sounds
       like money or a link is either a price field (empty for a teammate without See prices) or on a reasoned list;
     - the source guards: only the files listed read the tables whose columns are money only by route.

   The routes themselves, on a real database, are in permission-costs-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { isMoneyMetadataKey, omitPricesFromAnswers } from '../lib/permissions/prices';
import { MERGE_FIELD_LABELS } from '../services/automations/catalog';
import { NOT_PRICE_MERGE_FIELDS, PRICE_MERGE_FIELDS, withoutPriceFields } from '../services/automations/priceMergeFields';

type Seen = { prices: boolean; costs: boolean };

/** Runs a payload through the middleware as the app mounts it, for a person holding these two grants. */
function answer(address: string, payload: unknown, seen: Seen): any {
  let sent: unknown;
  const res: any = { json: (body: unknown) => { sent = body; return res; } };
  const req: any = {
    user: { id: 'u' },
    originalUrl: address,
    ability: { can: (_action: string, subject: string) => (subject === 'Prices' ? seen.prices : subject === 'Pricing' ? seen.costs : false) },
  };
  omitPricesFromAnswers(req, res, () => undefined);
  res.json(payload);
  return sent;
}

const NONE: Seen = { prices: false, costs: false };
const PRICES: Seen = { prices: true, costs: false };
const BOTH: Seen = { prices: true, costs: true };

/** Every cost key the 22 cost columns travel under, snake_case and camelCase. */
const COST_KEYS = [
  'unit_cost', 'markup_percent', 'internal_cost', 'cost_override', 'default_markup_pct', 'labor_hours', 'labor_rate', 'overhead_mode', 'overhead_value',
  'unitCost', 'markupPercent', 'internalCost', 'costOverride', 'defaultMarkupPct', 'laborHours', 'laborRate', 'overheadMode', 'overheadValue',
];
const PRICE_KEYS = ['contract_price', 'default_price', 'contractPrice', 'defaultPrice', 'total_amount', 'unit_price'];

function keysIn(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysIn(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysIn(v, out); }
  return out;
}

const payload = () => ({
  name: 'kept',
  rows: [{ id: 1, nested: { deeper: [Object.fromEntries([...COST_KEYS, ...PRICE_KEYS].map((k) => [k, 1])), { name: 'kept' }] } }],
});

describe('M4: the central filter hides costs under See costs and prices under See prices', () => {
  it('a person with neither switch gets neither class', () => {
    const keys = keysIn(answer('/api/anything', payload(), NONE));
    for (const k of [...COST_KEYS, ...PRICE_KEYS]) expect(keys.has(k), k).toBe(false);
    expect(keys.has('name')).toBe(true);
  });

  it('a person with See prices only gets the prices and none of the costs', () => {
    const keys = keysIn(answer('/api/anything', payload(), PRICES));
    for (const k of COST_KEYS) expect(keys.has(k), k).toBe(false);
    for (const k of PRICE_KEYS) expect(keys.has(k), k).toBe(true);
  });

  it('a person with both gets everything', () => {
    const keys = keysIn(answer('/api/anything', payload(), BOTH));
    for (const k of [...COST_KEYS, ...PRICE_KEYS]) expect(keys.has(k), k).toBe(true);
  });

  it('leaves an answer alone when nobody is signed in or the route never loaded an ability', () => {
    let sent: unknown;
    const res: any = { json: (b: unknown) => { sent = b; return res; } };
    omitPricesFromAnswers({ originalUrl: '/api/x' } as any, res, () => undefined);
    res.json(payload());
    expect(keysIn(sent).has('unit_cost')).toBe(true);
  });

  it('reads the address the way the router does: capitals, a trailing "/" and a doubled "/" still hide the cost', () => {
    for (const address of ['/API/Scope-Presets/', '/api//scope-presets', '/api/scope-presets?x=1#f']) {
      const body = answer(address, { presets: [{ name: 'Door', price: 120, internal_cost: 45 }] }, NONE);
      expect(body.presets[0], address).toEqual({ name: 'Door' });
    }
  });
});

describe('M4: names that are money only on some routes are hidden there, and only there', () => {
  it('a preset\'s price is a price, its internal cost is a cost', () => {
    const body = { presets: [{ name: 'Door', price: 120, internal_cost: 45 }] };
    expect(answer('/api/scope-presets', body, PRICES).presets[0]).toEqual({ name: 'Door', price: 120 });
    expect(answer('/api/scope-presets', body, BOTH).presets[0]).toEqual({ name: 'Door', price: 120, internal_cost: 45 });
    expect(answer('/api/scope-presets', body, NONE).presets[0]).toEqual({ name: 'Door' });
    // A `price` on another route is not touched by this rule.
    expect(answer('/api/tags', { tags: [{ price: 1 }] }, NONE).tags[0]).toEqual({ price: 1 });
  });

  it('a vendor quote\'s total is a cost on the request-for-quote routes only', () => {
    const body = { rfq: { quotes: [{ vendor: 'V', total: 900, leadTimeDays: 3 }] } };
    expect(answer('/api/inventory/rfqs/x', body, PRICES).rfq.quotes[0]).toEqual({ vendor: 'V', leadTimeDays: 3 });
    expect(answer('/api/inventory/rfqs/x', body, BOTH).rfq.quotes[0]).toEqual({ vendor: 'V', total: 900, leadTimeDays: 3 });
    expect(answer('/api/inventory/vendors', { vendors: [{ total: 5 }] }, NONE).vendors[0]).toEqual({ total: 5 });
  });

  it('the filter does not read a bell: no amount is stored or served for it, and the words in it are never scanned (permission-bells-no-money.test.ts)', () => {
    const body = { items: [{ verb: 'communication.sms_inbound', title: 'New text', body: 'Can you do it for $500?', data: { preview: 'Can you do it for $500?' } }] };
    expect(answer('/api/notifications', body, NONE)).toEqual(body);
  });

  it('a history entry leaves out every figure it keeps, under whatever key the writer used', () => {
    const entry = { event_type: 'CHARGEBACK_PARTIAL', description: 'x', metadata: { amount: 5, overpaid: 4, amount_cents: 500, disputed_cents: 400, unrefunded_cents: 1000, tip_amount: 2, amount_due: 3, owed_amount: 1, payment_id: 'p' } };
    expect(answer('/api/invoices/x/timeline', { events: [entry] }, NONE).events[0].metadata).toEqual({ payment_id: 'p' });
    expect(answer('/api/invoices/x/timeline', { events: [entry] }, PRICES).events[0].metadata).toEqual(entry.metadata);
  });

  it('a customer\'s pending deposits are a price, the count of pending estimates is not', () => {
    const page = { summary: { estimates: { pending: 3, total_value: 9 }, deposits: { collected: 5, pending: 25 } } };
    expect(answer('/api/customers/x', page, NONE).summary).toEqual({ estimates: { pending: 3 }, deposits: {} });
    const summary = { estimates: { pending: 3 }, deposits: { collected: 5, pending: 25 } };
    expect(answer('/api/customers/x/summary', summary, NONE)).toEqual({ estimates: { pending: 3 }, deposits: {} });
    expect(answer('/api/customers/x/summary', summary, PRICES)).toEqual(summary);
  });
});

describe('M4: merge fields that render a price or the customer\'s private link (guard)', () => {
  const MONEYISH = /(?:^|[._])(total|amount|price|balance|deposit|cost|fee|tip|tax|paid|due|owed|link|token|url|discount|refund)(?:$|[._])/;

  it('every advertised merge field that sounds like money or a link is decided', () => {
    const undecided = Object.keys(MERGE_FIELD_LABELS)
      .filter((f) => MONEYISH.test(f))
      .filter((f) => !PRICE_MERGE_FIELDS.includes(f) && !(f in NOT_PRICE_MERGE_FIELDS));
    expect(undecided).toEqual([]);
  });

  it('every merge field the context builder sets that sounds like money or a link is decided', () => {
    const source = readFileSync(join(__dirname, '..', 'services', 'automations', 'context.ts'), 'utf8');
    const set = [...source.matchAll(/^\s+'([a-z_]+\.[a-z_]+)':/gm)].map((m) => m[1]!);
    expect(set.length).toBeGreaterThan(20);
    const undecided = set.filter((f) => MONEYISH.test(f)).filter((f) => !PRICE_MERGE_FIELDS.includes(f) && !(f in NOT_PRICE_MERGE_FIELDS));
    expect([...new Set(undecided)]).toEqual([]);
  });

  it('the price merge fields are advertised, are set by the context builder, and are not on the reasoned list', () => {
    const source = readFileSync(join(__dirname, '..', 'services', 'automations', 'context.ts'), 'utf8');
    for (const f of PRICE_MERGE_FIELDS) {
      expect(f in MERGE_FIELD_LABELS, f).toBe(true);
      expect(source.includes(`'${f}':`), f).toBe(true);
      expect(f in NOT_PRICE_MERGE_FIELDS, f).toBe(false);
    }
  });

  it('a teammate\'s context keeps every field and empties the price ones; the rest is untouched', () => {
    const ctx = { 'estimate.number': 'E-1', 'estimate.total': '$100.00', 'estimate.link': 'https://x/p/estimates/1?token=t', 'invoice.total': '$5.00', 'invoice.link': 'https://x', 'customer.first_name': 'Pat' };
    expect(withoutPriceFields(ctx)).toEqual({
      'estimate.number': 'E-1', 'estimate.total': '', 'estimate.link': '', 'invoice.total': '', 'invoice.link': '', 'customer.first_name': 'Pat',
    });
    // The input is not changed: the customer's send still reads it.
    expect(ctx['estimate.total']).toBe('$100.00');
  });
});

describe('M4: who reads the tables whose money is named by route only (source guard)', () => {
  const SRC = join(__dirname, '..');
  function files(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === '__tests__' || name === 'node_modules') continue;
      if (statSync(full).isDirectory()) files(full, out);
      else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  }
  const readers = (pattern: RegExp) => files(SRC).filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => f.slice(SRC.length + 1)).sort();

  it('only the preset controller reads scope presets (its `price` is hidden by the /api/scope-presets rule)', () => {
    expect(readers(/prisma\.scopePreset\b|tx\.scopePreset\b/)).toEqual(['controllers/scope-preset.controller.ts']);
  });

  it('only the purchase-order controller reads vendor quotes (their `total` is hidden by the /api/inventory/rfqs rule)', () => {
    expect(readers(/\brfqQuote\b/)).toEqual(['controllers/inv-po.controller.ts', 'lib/purge.ts']);
  });

  it('only the service-plan controller, the dashboard tile and the price filter name what a plan sells for', () => {
    expect(readers(/\bcontract_price\b/)).toEqual(['controllers/service-plan.controller.ts', 'lib/permissions/prices.ts', 'seed-demo-org.ts', 'services/dashboard/moneyTiles.ts']);
  });
});

describe('M4: no history entry names a figure in its words or hides one under a key the route misses (writer-driven source guard)', () => {
  const SRC = join(__dirname, '..');
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
  function files(dir: string, out: Record<string, string> = {}): Record<string, string> {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === '__tests__' || name === 'node_modules') continue;
      if (statSync(full).isDirectory()) files(full, out);
      else if (name.endsWith('.ts')) out[full.slice(SRC.length + 1)] = readFileSync(full, 'utf8');
    }
    return out;
  }

  /** A figure being put into words: a formatter, `toFixed`, a "$" in front of an interpolation, or a literal ending in "$" that a figure is added to (`'Paid $' + n`, `'$' + n`). */
  const FIGURE = /\$\$\{|\$\{[^}]*(?:\busd\b|usdCents|dollars|toFixed|formatCurrency|Intl\.NumberFormat)|\.toFixed\(|\busd\(|\busdCents\(|\bdollars\(|\bmoney\(|formatCurrency\(|Intl\.NumberFormat|toLocaleString\(|[\s'"`]\$['"]\s*(?:\+|\.concat\()/;
  /** A place a history entry is stored: a timeline event written, or a job's money line, or the helper every entry goes through. */
  const WRITER = /timelineEvent\.(?:create|createMany)\b|\btx\.timelineEvent\b|\bdb\.timelineEvent\b|recordJobMoneyMovement\b/;

  /**
   * Every line, in a file that writes history or in a file such a file imports, that formats a figure - minus the lines that are
   * not history words. Followed from the WRITERS, not from the word "description": a text built in a helper, in a variable, in a
   * ternary or in another module is caught the same way, because the helper has to format the figure somewhere.
   */
  function figureLines(sources: Record<string, string>, allowed: Record<string, readonly string[]>, allowedFiles: Record<string, string>): string[] {
    const writers = Object.keys(sources).filter((f) => WRITER.test(sources[f]!));
    const scope = new Set(writers);
    for (const w of writers) {
      for (const m of sources[w]!.matchAll(/from '(\.[^']+)'/g)) {
        const base = join(w, '..', m[1]!).replace(/\\/g, '/');
        for (const cand of [`${base}.ts`, `${base}/index.ts`]) if (sources[cand]) scope.add(cand);
      }
    }
    const out: string[] = [];
    for (const f of [...scope].sort()) {
      if (f in allowedFiles) continue;
      sources[f]!.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (/^(?:\/\/|\*|\/\*)/.test(t) || !FIGURE.test(line)) return;
        if ((allowed[f] ?? []).some((prefix) => t.startsWith(prefix))) return;
        out.push(`${f}:${i + 1}: ${t.slice(0, 110)}`);
      });
    }
    return out;
  }

  /** Lines of a history WRITER that format a figure and are not history words, each with why. Anything else fails. */
  const ALLOWED_LINES: Record<string, readonly string[]> = {
    'controllers/customer.controller.ts': ['response.warning = `$${money.paymentTotal.toFixed(2)}'], // a warning to the person about to purge a customer
    'controllers/estimate.controller.ts': [
      'const fmt = (n: number)', // formats the deposit in the CUSTOMER's email
      'total: new Intl.NumberFormat', // the total in the CUSTOMER's approval email
    ],
    'controllers/invoice-lines.controller.ts': ['return new Intl.NumberFormat'], // a formatter for the editor the person is looking at
    'controllers/invoice.controller.ts': [
      '`The invoice must be at least', // a refusal to the person pressing the button
      'data: { object_label: invoice.invoice_number, amount: Number(amount).toFixed(2) }', // a bell's data bag: stripped before it is stored
    ],
    'controllers/payment-attention.controller.ts': ['const dollars = (cents: number)', 'if (leftCents != null && cents > leftCents)'], // a refusal to the person pressing the button; the figure only with See prices (P2-2)
    // Refusals to the person pressing the button; the figure only with See prices (re-audit P2-2, `input.figures`).
    'services/payment-attention/attach.ts': ['const usd = (cents: number)', '? `Only ${usd(payableCents)}', 'const left = input.figures ? usd(amountCents)'],
    'services/payment-reconciler/checkout-effects.ts': ['new Intl.NumberFormat', 'amount: (notice.amountCents / 100).toFixed(2)', 'data: { amount: formatCurrency(amount) }', 'data: { object_label: invoice.invoice_number, amount: Number(amount).toFixed(2) }', 'total: formatCurrency('], // bell data (stripped before it is stored) and the CUSTOMER's emails
    'services/payment-reconciler/index.ts': ['amount: (cents / 100).toFixed(2)', 'amount: (dispute.amount / 100).toFixed(2)', 'amount: (notice.amountCents / 100).toFixed(2)'], // bell data (stripped before it is stored)
  };
  /** Files a writer imports that format figures for something else entirely. */
  const ALLOWED_FILES: Record<string, string> = {
    'lib/email.ts': 'emails and PDFs: the customer\'s own bill; the staff alerts name no amount (permission-staff-emails-no-money-db)',
    'lib/timezone.ts': 'dates, not money',
    'lib/dispute-evidence.ts': 'a character count',
    'lib/purge-policy.ts': 'a purge preview number',
    'lib/payout-sync.ts': 'the payout record, not history',
    'lib/checkout-pricing.ts': 'a refusal to the person recording a payment, and the customer\'s checkout',
    'lib/job-close-out.ts': 'a refusal to the person confirming a close-out (the figure was just shown to them)',
    'lib/job-review-changeset.ts': 'the office review panel, which Ran is deciding separately',
    'services/automations/context.ts': 'merge fields, emptied for a teammate without See prices (round 1)',
    'services/payments-page.ts': 'the Payments page, which needs See prices to open',
    'lib/estimates/public-link.ts': 'a fingerprint of the customer-facing document, not words',
  };

  it('no line that writes or builds history words formats a figure (followed from the writers, helpers included)', () => {
    expect(figureLines(files(SRC), ALLOWED_LINES, ALLOWED_FILES)).toEqual([]);
  });

  it('catches a description built in a helper or a variable, and one built in another module', () => {
    const planted = {
      'lib/planted-writer.ts': [
        "import { said } from './planted-words';",
        'const figureWords = (c: number) => `${usd(c)} was moved`;',
        'const usd = (c: number) => `$${(c / 100).toFixed(2)}`;',
        'export async function write(tx: any, c: number) {',
        '  const description = figureWords(c);',
        "  await tx.timelineEvent.create({ data: { event_type: 'X', description } });",
        "  await tx.timelineEvent.create({ data: { event_type: 'Y', description: said(c) } });",
        '}',
      ].join('\n'),
      'lib/planted-words.ts': 'export const said = (n: number) => `${n} came in as $${n.toFixed(2)}`;',
    };
    const found = figureLines(planted, {}, {});
    expect(found.filter((l) => l.startsWith('lib/planted-writer.ts')).length).toBeGreaterThanOrEqual(2);
    expect(found.filter((l) => l.startsWith('lib/planted-words.ts'))).toHaveLength(1);
  });

  it('catches a figure joined on with +, however the "$" is quoted', () => {
    const planted = {
      'lib/planted-writer.ts': [
        'export async function cancelBankPayment(tx: any, p: any) {',
        "  await tx.timelineEvent.create({ data: { event_type: 'X', description: 'Bank payment of $' + String(p.amount) } });",
        "  const a = '$' + p.amount;",
        '  const b = "$".concat(String(p.amount));',
        "  const fine = 'costs $5 flat' + p.name;",
        '}',
      ].join('\n'),
    };
    expect(figureLines(planted, {}, {}).map((l) => l.split(':')[1])).toEqual(['2', '3', '4']);
  });

  /**
   * The keys of every `metadata: { ... }` object a history writer stores (explicit keys and shorthand, at the top level of
   * the object), and the rule: a key that reads as money under a wide list of money words must be one the history route
   * leaves out (`isMoneyMetadataKey`), unless it is listed here as a flag, a date or a reference.
   */
  /** History writers for the metadata guard: timeline entries AND the audit rows the estimate's History tab serves. */
  const METADATA_WRITER = new RegExp(`${WRITER.source}|\\blogAudit\\(|\\bauditLog\\.create\\b`);
  function metadataKeys(sources: Record<string, string>): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [file, text] of Object.entries(sources)) {
      if (!METADATA_WRITER.test(text)) continue;
      for (const m of text.matchAll(/metadata:\s*\{/g)) {
        let depth = 0;
        let i = m.index! + m[0].length - 1;
        const start = i;
        for (; i < text.length; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}' && --depth === 0) break;
        }
        const body = text.slice(start + 1, i);
        // Split the top level on commas, ignoring nested brackets.
        const parts: string[] = [];
        let d = 0;
        let cur = '';
        for (const ch of body) {
          if ('{[('.includes(ch)) d++;
          if ('}])'.includes(ch)) d--;
          if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
        }
        parts.push(cur);
        for (const part of parts) {
          const t = part.trim();
          if (!t || t.startsWith('...')) continue;
          const key = /^['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*(?::|$)/.exec(t)?.[1];
          if (key) out.push([file, key]);
        }
      }
    }
    return out;
  }
  const WIDE_MONEY = /amount|cents|price|total|balance|owed|due|tip|fee|overpaid|charged|refunded|paid|expected|disputed|unrefunded|unapplied|cost|markup|credit|refund|deposit|value|sum/i;
  /** Keys that carry a word from the wide list and are not figures: a yes/no flag, a date or a reference. */
  const NOT_A_FIGURE = new Set(['fully_paid', 'isFullyPaid', 'unapplied_capture_id', 'paid_at', 'refunded_at']);
  /** A key the route would miss that reads as money: the wide words, minus references and dates (`refund_id`, `deposit_invoice_id`, `paid_at`) and the listed flags. */
  const missedMoneyKey = (key: string) => WIDE_MONEY.test(key) && !NOT_A_FIGURE.has(key) && !/(?:_ids?|Ids?|_at|At)$/.test(key) && !isMoneyMetadataKey(key);

  it('every key a history writer stores that reads as money is one the history route leaves out', () => {
    const offenders = metadataKeys(files(SRC))
      .filter(([, key]) => missedMoneyKey(key))
      .map(([file, key]) => `${file}: ${key}`);
    expect([...new Set(offenders)]).toEqual([]);
  });

  /**
   * Words a person reads - a history entry, a bell, a staff email - never name a vendor (CLAUDE.md). Every string literal in a
   * history writer, in what it imports, and in the bell and email wording files is checked; logger lines, thrown errors and
   * comments are not user words and are skipped. The bell templates' `exception:` notes are developer documentation.
   */
  /** Operator-only text a writer file carries (a server log, a startup error): nobody reads it in the app. */
  const OPERATOR_ONLY: Array<[string, string]> = [
    ['app.ts', 'ctm-webhook door is restricted'],
    ['controllers/ctm-webhook.controller.ts', '[ctm-webhook] processing failed'],
    ['lib/e2e-org.ts', 'Set E2E_ALLOWED_DB_REF'],
  ];
  const VENDOR = /\b(?:stripe|ctm|calltrackingmetrics|supabase|twilio|quickbooks)\b|render\.com|resend\.com/i;
  function vendorLines(sources: Record<string, string>, extra: string[]): string[] {
    const writers = Object.keys(sources).filter((f) => WRITER.test(sources[f]!));
    const scope = new Set([...writers, ...extra.filter((f) => sources[f])]);
    for (const w of writers) {
      for (const m of sources[w]!.matchAll(/from '(\.[^']+)'/g)) {
        const base = join(w, '..', m[1]!).replace(/\\/g, '/');
        for (const cand of [`${base}.ts`, `${base}/index.ts`]) if (sources[cand]) scope.add(cand);
      }
    }
    const literal = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
    const out: string[] = [];
    for (const f of [...scope].sort()) {
      sources[f]!.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (/^(?:\/\/|\*|\/\*)/.test(t) || /logger\.|console\.|throw new|exception:|Its only path is/.test(t)) return;
        for (const m of line.matchAll(literal)) {
          const text = m[1] ?? m[2] ?? m[3] ?? '';
          // Words, not identifiers: a column, a header or an import path has no spaces.
          if (OPERATOR_ONLY.some(([file, part]) => f === file && text.includes(part))) continue;
          if (/\s/.test(text.trim()) && VENDOR.test(text)) out.push(`${f}:${i + 1}: ${text.slice(0, 100)}`);
        }
      });
    }
    return out;
  }

  it('no history entry, bell or staff email names a vendor in its words', () => {
    const words = ['services/notifications/templates.ts', 'services/notifications/whyLines.ts', 'lib/email.ts', 'lib/owner-payment-notices.ts', 'lib/payments-notifications.ts'];
    expect(vendorLines(files(SRC), words)).toEqual([]);
  });

  it('catches a vendor word in a history writer or in a module it imports', () => {
    const planted = {
      'lib/planted-writer.ts': "import { said } from './planted-words';\nawait tx.timelineEvent.create({ data: { description: 'Refund recorded via Stripe dashboard' } });\nawait tx.timelineEvent.create({ data: { description: said() } });\nlogger.info('Stripe says hello');",
      'lib/planted-words.ts': 'export const said = () => `Payment received via CallTrackingMetrics`;',
    };
    expect(vendorLines(planted, [])).toEqual([
      'lib/planted-words.ts:1: Payment received via CallTrackingMetrics',
      'lib/planted-writer.ts:2: Refund recorded via Stripe dashboard',
    ]);
  });

  it('catches a figure stored under a plain money word the route does not know (credit, refund, deposit, value, sum)', () => {
    const planted = { 'lib/planted-writer.ts': "await tx.timelineEvent.create({ data: { metadata: { credit: p.amount, refundSum: 5, deposit: d, item_value: 2, payment_id: p.id } } });" };
    const missed = metadataKeys(planted).filter(([, key]) => missedMoneyKey(key)).map(([, key]) => key);
    expect(missed).toEqual(['credit', 'refundSum', 'deposit', 'item_value']);
  });

  it('catches a figure a writer stores under a key the route would miss', () => {
    const planted = { 'lib/planted-writer.ts': "await tx.timelineEvent.create({ data: { metadata: { payment_id: p.id, charged_cents: 1, paid_so_far: 5, fully_paid: true } } });" };
    expect(metadataKeys(planted).map(([, k]) => k)).toEqual(['payment_id', 'charged_cents', 'paid_so_far', 'fully_paid']);
    const missed = metadataKeys(planted).filter(([, key]) => missedMoneyKey(key)).map(([, key]) => key);
    expect(missed).toEqual(['paid_so_far']);
    // And the rule itself, by example.
    for (const money of ['charged_cents', 'unapplied_cents', 'disputed_cents', 'unrefunded_cents', 'expected_cents', 'amount_cents', 'overpaid', 'tip_amount', 'amount_due', 'owed_amount', 'collected_total', 'estimate_total', 'estimateTotal']) {
      expect(isMoneyMetadataKey(money), money).toBe(true);
    }
    for (const plain of ['payment_id', 'reason', 'method', 'due_date', 'paid_at', 'invoice_status', 'stripe_payment_intent', 'event_id', 'refund_id', 'bank_return']) {
      expect(isMoneyMetadataKey(plain), plain).toBe(false);
    }
  });

  it('the sites that used to put a figure into a history entry no longer do', () => {
    const lines = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
    const forbid: Array<[string, RegExp]> = [
      ['controllers/invoice.controller.ts', /description: `[^`]*\$\$\{/],
      ['controllers/estimate.controller.ts', /description: `[^`]*\$\$\{/],
      ['services/payment-reconciler/apply.ts', /(?:history\('[A-Z_]+', |description: )`[^`]*(?:\$\$\{|\$\{usd)/],
      ['lib/job-change-history.ts', /`Invoice \$\{invoice\.invoice_number\} \$\{MONEY_VERB\[kind\]\}[^`]*\$\$/],
      ['lib/job-mark-done.ts', /still owed`[^\n]*\$\{dollars/],
      ['controllers/payment-attention.controller.ts', /description: `\$\$\{/],
    ];
    for (const [rel, bad] of forbid) expect(lines(rel), rel).not.toMatch(bad);
    // And the notification rule that scanned a bell's words, and the history rule that scanned a description, are gone.
    expect(lines('lib/permissions/prices.ts')).not.toMatch(/redactDollarAmounts|text: \['description'\]|text: \['title', 'body'\]/);
  });

  /**
   * Nothing scans words (Ran, 2026-10-28/29): no helper that finds dollar figures in a description, a message, a note or a
   * preview, and no regular expression written to find one. Redacting is done on FIELDS (the key rules), never on text.
   */
  it('no non-test code scans text for money', () => {
    const roots = [join(__dirname, '..'), join(__dirname, '..', '..', '..', 'frontend', 'src')];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === '__tests__' || name === 'node_modules') continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && !/\.stories\./.test(name)) {
          readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
            // A helper by name, or a regular expression that looks for a dollar sign followed by digits.
            if (/redactDollar|stripDollar|stripAmounts|redactAmounts|scrubAmounts|dollarAmounts?\b/i.test(line) || /\\\$\s*\??\\?(?:d|\[0-9)/.test(line) || /\\\$\s*\?\s*\[\\?d0-9/.test(line)) {
              offenders.push(`${full.slice(full.indexOf('/backend/') > 0 ? full.indexOf('/backend/') + 1 : full.indexOf('/frontend/') + 1)}:${i + 1}`);
            }
          });
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
