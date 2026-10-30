/* =============================================================================
   Contact-action guard (mobile slice 50) - zero tolerance, not a ratchet.

   No live staff code may build a telephone URL (`tel:`) or a text URL (`sms:`) outside the
   contact action (`components/contact/`). Every number a user can tap goes through that one
   component, which decides between the ServWave dialer, the ServWave conversation and the device's
   own links. A plain `tel:` link anywhere else bypasses the dialer, so the call is neither
   attributed to the record nor logged.

   WHAT COUNTS AS A TELEPHONE URL. A STRING (a literal, a template, a JSX attribute) that BEGINS with
   the scheme. It is matched on the syntax tree, not on text, so a comment or a doc string that
   merely talks about `tel:` links does not trip it, and a programmatic navigation
   (`window.location.href = \`tel:${n}\``, `openHref('tel:...')`) is caught exactly like an
   `<a href>`. The slice's first draft counted links only; about half the sites were buttons that
   assign the location.

   WHAT IS ALLOWED, AND WHY EACH ENTRY IS HERE.
     - components/contact/       the contact action itself.
     - the public customer pages keep a plain call link for the business's number: a customer has
       no dialer (Module 9 of the mobile PRD).
     - lib/safe-href.ts          the allow-list of link schemes an untrusted URL may use; a list of
       names, never a link.
     - DEAD_SCREENS             screens no route renders. They are left alone, not migrated. Each is
       proven dead below: nothing live imports it.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SCHEME = /^\s*(tel|sms|smsto|facetime|facetime-audio):/i;

/** Where telephone URLs may be built. Paths are relative to src/, forward slashes. */
const ALLOWED_PREFIXES = [
  'components/contact/',
  // The customer has no ServWave dialer: the public estimate and invoice pages keep a plain call link.
  'pages/v2/auth-public/components/publicShell.tsx',
  // The scheme allow-list for untrusted URLs.
  'lib/safe-href.ts',
];

/**
 * Screens that no route renders (the v1 pages the v2 rebuild replaced). Each maps to the only files
 * allowed to import it, which are other dead screens and a barrel nobody imports a member of.
 */
const DEAD_SCREENS: Record<string, string[]> = {
  'components/schedule/EventEditor.tsx': [],
  'pages/CustomerDetailPage.tsx': [],
  'pages/InvoiceDetailPage.tsx': [],
  'components/data/ContactCell.tsx': [
    'pages/LeadsPage.tsx',
    'pages/CustomersPage.tsx',
    'components/data/index.ts',
  ],
};

function isTestOrStory(file: string): boolean {
  return /\.(test|stories)\.tsx?$/.test(file);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !isTestOrStory(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string) => relative(SRC, file).split('\\').join('/');

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Every string in the file that begins with a telephone or text scheme, with its line. */
export function telephoneUrlsIn(text: string, fileName = 'x.tsx'): { line: number; text: string }[] {
  const sf = parse(fileName, text);
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    let value: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
    else if (ts.isTemplateHead(node)) value = node.text;
    else if (ts.isJsxText(node)) value = node.text;
    if (value !== null && SCHEME.test(value)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({ line: line + 1, text: value.trim().slice(0, 40) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every module specifier the file imports, re-exports or dynamically imports. */
function importSpecifiers(text: string, fileName: string): string[] {
  const sf = parse(fileName, text);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(fromFile), spec) : null;
  if (!base) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return rel(candidate);
  }
  return null;
}

describe('the scanner', () => {
  it('catches links, navigations and templates, and ignores prose', () => {
    const code = [
      '// a tel: link in a comment',
      '/* sms: in a block comment */',
      'export const a = <a href="tel:5551234567">x</a>;',
      'export const b = `tel:${n}`;',
      "export const c = () => { window.location.href = 'sms:5551234567'; };",
      "openHref(`sms:${n}`);",
      'export const d = "https://example.com/hotel:room";',
      'export const e = "Call the hotel: now";',
    ].join('\n');
    expect(telephoneUrlsIn(code).map((f) => f.line)).toEqual([3, 4, 5, 6]);
  });
});

describe('no telephone URL outside the contact action', () => {
  const live = sourceFiles(SRC).filter((f) => {
    const r = rel(f);
    return !ALLOWED_PREFIXES.some((p) => r.startsWith(p)) && !(r in DEAD_SCREENS);
  });

  it('scans the live staff code', () => {
    // A guard that scanned nothing would pass for ever.
    expect(live.length).toBeGreaterThan(500);
    expect(live.map(rel)).toContain('pages/v2/customers/CustomerDetailPage.tsx');
  });

  it('finds none in any live file', () => {
    const offenders: string[] = [];
    for (const file of live) {
      for (const hit of telephoneUrlsIn(readFileSync(file, 'utf8'), file)) {
        offenders.push(`${rel(file)}:${hit.line}  ${hit.text}`);
      }
    }
    expect(
      offenders,
      'A telephone or text URL was built outside components/contact/. Draw a customer or crew phone through ' +
        'the contact display policy (PhoneValue, PhoneContactActions), or a vendor number with PhoneNumberAction, ' +
        'so the call goes through the dialer and is attributed.',
    ).toEqual([]);
  });
});

describe('the screens left alone are really dead', () => {
  const importers = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    for (const spec of importSpecifiers(readFileSync(file, 'utf8'), file)) {
      const target = resolveSpecifier(spec, file);
      if (target && target in DEAD_SCREENS) importers.set(target, [...(importers.get(target) ?? []), rel(file)]);
    }
  }

  for (const [dead, allowed] of Object.entries(DEAD_SCREENS)) {
    it(`${dead} is imported by nothing live`, () => {
      expect(existsSync(join(SRC, dead)), 'delete the entry: the file is gone').toBe(true);
      const unexpected = (importers.get(dead) ?? []).filter((r) => !allowed.includes(r));
      expect(unexpected, `now imported by live code: migrate ${dead} to the contact action`).toEqual([]);
    });
  }
});

/**
 * Roles & Permissions S05.5: ONE way a customer phone is drawn and acted on - through the contact display policy
 * (components/contact/contactDisplayPolicy.ts). The older shared contact action decides from the `create Communication`
 * ability alone and ignores the copy switches, so it is left to numbers that are not customer data. Today that is the
 * vendor card and the vendor detail dialog (a vendor's phone is not a customer's); a screen that draws a customer's
 * phone must not come back to it.
 */
describe('the older contact action serves only numbers that are not a customer\'s', () => {
  const VENDOR_SCREENS = ['components/inventory/VendorCard.tsx', 'components/inventory/VendorDetailDialog.tsx'];

  it('is imported by the vendor screens and nothing else', () => {
    const importers: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'), file)) {
        if (resolveSpecifier(spec, file) === 'components/contact/ContactAction.tsx') importers.push(rel(file));
      }
    }
    expect(importers.sort()).toEqual(VENDOR_SCREENS);
  });
});
