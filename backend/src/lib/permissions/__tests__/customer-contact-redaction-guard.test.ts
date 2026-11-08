/**
 * #1997 — source-scanning guard: every detail-shaped estimate/invoice response goes through
 * `presentEstimateDetail` / `presentInvoiceDetail` as its LAST transform, so a NEW handler built
 * off `estimateDetailSelect` / `invoiceDetailSelect` cannot forget the customer-contact redaction
 * the way the pre-fix codebase forgot it at 9 BARE estimate sites (spec: this enumeration's only
 * durable enforcement — everything else is a per-site behavioral test that only catches a
 * regression at the sites it happens to name).
 *
 * Shape mirrors `lib/pdf/__tests__/pdf-rendering-guard.test.ts` (a whole-surface guard that runs
 * in CI) rather than that file's exact mechanism (it exercises the real renderer; this reads the
 * controller source, because the thing being guarded is a call-site convention, not runtime
 * behavior a fixture could exercise cheaply for every one of ~48 sites).
 *
 * Method: split each controller file into its TOP-LEVEL functions (declarations starting at
 * column 0 — nested helpers never re-open a new boundary). Every `res.json(...)` /
 * `res.status(n).json(...)` call AND every `return { ok: true, ... }` internal-helper return
 * (the shape `sendInvoiceInternal`/`resendInvoiceInternal` use — the exported `send`/`resend`
 * wrapper re-applies the presenter over the already-redacted result, an idempotent no-op, so the
 * wrapper needs no exemption) whose payload carries an `estimate:` or `invoice:` KEY (with a
 * colon — the shorthand `{ ok: true, estimate }` some internal helpers return does not count,
 * because the wrapper that consumes it is what actually shapes the response) must carry
 * `presentEstimateDetail(` / `presentInvoiceDetail(` on the SAME statement.
 *
 * A handful of functions are named exemptions (`EXEMPT_FUNCTIONS` below) rather than being
 * naturally excluded by a select-name filter: `estimateDetailSelect`/`invoiceDetailSelect` do NOT
 * appear textually inside every handler that responds with a detail-shaped document (several are
 * split into an internal `xInternal` loader + a thin exported wrapper that only forwards the
 * result), so scoping by "does this function's own body mention the select" would silently skip
 * exactly the wrapper functions this guard exists to check. Scanning every non-exempt top-level
 * function instead, and naming the few genuine exceptions explicitly, is what the reviewer
 * amendment calls for ("explicitly exempt the estimatePublicSelect sites and the two renumber
 * responses, or it will fail on green code") — the companion "exemption is real, not silent"
 * tests below fail loudly if a future edit ever makes one of those exempted functions start
 * referencing a detail select while still being skipped by name.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const CONTROLLERS_DIR = join(__dirname, '../../../controllers');

interface FnBlock {
  name: string;
  text: string;
}

const TOP_LEVEL_FN_RE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
const TOP_LEVEL_CONST_FN_RE = /^export const (\w+)\s*=\s*(?:async\s*)?\(/;

function splitTopLevelFunctions(source: string): FnBlock[] {
  const lines = source.split('\n');
  const starts: { line: number; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = TOP_LEVEL_FN_RE.exec(line) ?? TOP_LEVEL_CONST_FN_RE.exec(line);
    if (m) starts.push({ line: i, name: m[1] as string });
  }
  const blocks: FnBlock[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!.line;
    const end = i + 1 < starts.length ? (starts[i + 1] as { line: number }).line : lines.length;
    blocks.push({ name: starts[i]!.name, text: lines.slice(start, end).join('\n') });
  }
  return blocks;
}

// Named by function, not by line — deliberately exempted because they respond off a DIFFERENT
// projection (estimatePublicSelect) or return no document at all ({ id, number }). If one of
// these ever starts referencing estimateDetailSelect/invoiceDetailSelect, the "exemption is real"
// tests below fail, which is the point: an exemption must be re-justified, not just widened.
const EXEMPT_FUNCTIONS = new Set([
  'approvePublic', 'declinePublic', // estimate.controller.ts — public token-gated, names only
  'renameNumber', 'previewNumber',  // both controllers — { id, number } / { number } only
]);

/** Balanced-paren extraction of a `res(...).json(ARGS)` / `res.json(ARGS)` call's ARGS text. */
function extractJsonCallArgs(text: string): string[] {
  const out: string[] = [];
  const callRe = /res(?:\.status\(\d+\))?\.json\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(text))) {
    const openIdx = m.index + m[0].length - 1; // index of the '(' that opens the call
    let depth = 0;
    let i = openIdx;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(openIdx + 1, i));
  }
  return out;
}

/** The `return { ok: true, estimate/invoice: ... }` internal-helper-return shape, single-line. */
function extractOkTrueReturns(text: string): string[] {
  const out: string[] = [];
  const re = /return \{ ok: true, [^;]*\};/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[0]);
  return out;
}

/**
 * Balanced-brace extraction of every `= { ... }` object-literal ASSIGNMENT — the shape
 * `waiveDeposit` uses (`const response: Record<string, unknown> = { estimate:
 * presentEstimateDetail(req, estimate) };`, then `res.json(response)` on the bare variable, which
 * `extractJsonCallArgs` cannot see into). Deliberately unfiltered by key here — `carriesKey`
 * upstream drops every unrelated assignment (select objects, plain data literals, etc.).
 */
function extractAssignedObjectLiterals(text: string): string[] {
  const out: string[] = [];
  const re = /=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const openIdx = m.index + m[0].length - 1; // index of the opening '{'
    let depth = 0;
    let i = openIdx;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(openIdx + 1, i));
  }
  return out;
}

/** A payload site's object literal carries this document key (with a colon — not the shorthand). */
function carriesKey(payload: string, key: 'estimate' | 'invoice'): boolean {
  return new RegExp(`(?:^\\s*|[{,]\\s*)${key}:`).test(payload);
}

function checkFile(fileName: string, presenterName: string, docKey: 'estimate' | 'invoice') {
  const source = readFileSync(join(CONTROLLERS_DIR, fileName), 'utf8');
  const blocks = splitTopLevelFunctions(source);
  const violations: string[] = [];
  let sitesChecked = 0;

  for (const block of blocks) {
    if (EXEMPT_FUNCTIONS.has(block.name)) continue;

    const sites = [
      ...extractJsonCallArgs(block.text),
      ...extractOkTrueReturns(block.text),
      ...extractAssignedObjectLiterals(block.text),
    ];
    for (const site of sites) {
      if (!carriesKey(site, docKey)) continue;
      sitesChecked++;
      if (!site.includes(`${presenterName}(`)) {
        violations.push(`${fileName}::${block.name} — a "${docKey}:" response site does not call ${presenterName}(): ${site.slice(0, 160)}`);
      }
    }
  }

  return { violations, sitesChecked };
}

describe('customer-contact redaction guard — every detail-shaped response calls the presenter', () => {
  it('estimate.controller.ts: every "estimate:" response site calls presentEstimateDetail()', () => {
    const { violations, sitesChecked } = checkFile('estimate.controller.ts', 'presentEstimateDetail', 'estimate');
    expect(violations).toEqual([]);
    // Sanity: the scan actually found sites to check, so a change to the source shape that makes
    // extraction silently match nothing does not read as "guard passed".
    expect(sitesChecked).toBeGreaterThanOrEqual(17);
  });

  it('estimate.controller.ts: copyToInvoice\'s invoice-shaped response calls presentInvoiceDetail()', () => {
    const { violations, sitesChecked } = checkFile('estimate.controller.ts', 'presentInvoiceDetail', 'invoice');
    expect(violations).toEqual([]);
    expect(sitesChecked).toBeGreaterThanOrEqual(1);
  });

  it('estimate-lines.controller.ts: every "estimate:" response site calls presentEstimateDetail()', () => {
    const { violations, sitesChecked } = checkFile('estimate-lines.controller.ts', 'presentEstimateDetail', 'estimate');
    expect(violations).toEqual([]);
    expect(sitesChecked).toBeGreaterThanOrEqual(8);
  });

  it('invoice.controller.ts: every "invoice:" response site calls presentInvoiceDetail()', () => {
    const { violations, sitesChecked } = checkFile('invoice.controller.ts', 'presentInvoiceDetail', 'invoice');
    expect(violations).toEqual([]);
    expect(sitesChecked).toBeGreaterThanOrEqual(12);
  });

  it('invoice-lines.controller.ts: every "invoice:" response site calls presentInvoiceDetail()', () => {
    const { violations, sitesChecked } = checkFile('invoice-lines.controller.ts', 'presentInvoiceDetail', 'invoice');
    expect(violations).toEqual([]);
    expect(sitesChecked).toBeGreaterThanOrEqual(11);
  });
});

describe('customer-contact redaction guard — the exemption is real, not silent', () => {
  it('the public approve/decline estimate sites never reference estimateDetailSelect (they use estimatePublicSelect)', () => {
    const source = readFileSync(join(CONTROLLERS_DIR, 'estimate.controller.ts'), 'utf8');
    const blocks = splitTopLevelFunctions(source);
    for (const name of ['approvePublic', 'declinePublic']) {
      const block = blocks.find((b) => b.name === name);
      expect(block, `expected a top-level function named ${name}`).toBeDefined();
      expect(block!.text.includes('estimateDetailSelect')).toBe(false);
      expect(block!.text.includes('estimatePublicSelect')).toBe(true);
    }
  });

  it('the renumber responses never reference a detail select and return no document', () => {
    for (const fileName of ['estimate.controller.ts', 'invoice.controller.ts']) {
      const source = readFileSync(join(CONTROLLERS_DIR, fileName), 'utf8');
      const blocks = splitTopLevelFunctions(source);
      const block = blocks.find((b) => b.name === 'renameNumber');
      expect(block, `expected a top-level function named renameNumber in ${fileName}`).toBeDefined();
      expect(block!.text.includes('estimateDetailSelect')).toBe(false);
      expect(block!.text.includes('invoiceDetailSelect')).toBe(false);
    }
  });
});
