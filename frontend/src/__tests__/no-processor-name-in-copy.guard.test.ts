/* =============================================================================
   No processor name in anything a user can see (payments go-live slice 33).

   CLAUDE.md boundary: a vendor's name never reaches rendered copy, a toast, a
   tooltip, the DOM, the browser console or a URL the user can read. Identifiers,
   type fields, API paths, env var names and comments may keep the name - they
   are how the code talks to the vendor.

   How this guard works: it parses every shipped source file with the TypeScript
   compiler and reads only what can reach the browser as TEXT - string literals
   (so toasts, labels, console arguments, class names, URLs), template pieces
   and JSX text. Comments and identifiers are never looked at. A literal that
   names the processor must match INTERNAL_LITERAL (a path, a package, an env var
   or an internal key, none of which is rendered). Anything else fails.

   It also fails if a shipped file is NAMED after the processor, because a
   component's file name becomes the name of the built chunk that the browser
   preloads (visible in the DOM and the network tab).
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname, '..');
const VENDOR = /stripe/i;
/**
 * The other vendors CLAUDE.md names (phone service, database host, app host). Same rule, same allowance, applied to the
 * screens the V7 payments build owns. The phone-service embed elsewhere in the app legitimately carries its own message
 * names and host, so it is not swept here.
 */
const OTHER_VENDORS = /supabase|calltracking|onrender|render\.com|\bctm\b/i;
const V7_SCREENS = [
  'pages/v2/payments/', 'pages/v2/settings/lists/', 'pages/v2/settings/servwavePayments/', 'pages/v2/settings/ServwavePaymentsPage.tsx',
  'components/payments/', 'components/contact/', 'components/ui/new-tab-link.tsx', 'components/form/MoveButtons.tsx',
  'components/form/PaletteSwatchPicker.tsx', 'pages/v2/_shared/',
];

/** Literals that name the processor but are never rendered: API paths, packages, env names, internal keys. */
const INTERNAL_LITERAL = [
  /^\/api\//, // internal route paths
  /^@stripe\//, // SDK imports
  /^VITE_STRIPE_[A-Z_]+$/, // env var names
  /^\.?(?:[a-z-]+\.)?stripe\.com$/, // the host filter that removes the processor's own tracking frames
  /^stripe[_-][a-z0-9_-]+$/, // internal keys: query keys, column names
  /^[a-z_]*stripe[a-z_]*$/, // column / field names
];

/** Shipped files only: tests, stories and fixtures never reach a user. */
function shippedFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === '__mocks__') continue;
      shippedFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|stories|guard\.test)\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every piece of text in a source file that can reach the browser, with its line. */
export function textLiterals(file: string): Array<{ text: string; line: number }> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ text: string; line: number }> = [];
  const add = (node: ts.Node, text: string) => {
    found.push({ text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node: ts.Node) => {
    // Module specifiers and type-level literal unions are never rendered.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node)) return;
    if (ts.isLiteralTypeNode(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) add(node, node.text);
    else if (ts.isJsxText(node)) add(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('no processor name reaches a user (slice 33)', () => {
  const files = shippedFiles(SRC);

  it('scans a real set of files', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('no shipped file is named after the processor (a file name becomes a preloaded chunk name)', () => {
    const named = files.filter((f) => VENDOR.test(path.basename(f))).map((f) => path.relative(SRC, f));
    expect(named).toEqual([]);
  });

  it('no string, template piece or JSX text names the processor, except internal keys and paths', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const { text, line } of textLiterals(file)) {
        if (!VENDOR.test(text)) continue;
        if (INTERNAL_LITERAL.some((re) => re.test(text.trim()))) continue;
        offenders.push(`${path.relative(SRC, file)}:${line}  ${JSON.stringify(text.trim().slice(0, 80))}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no string, template piece or JSX text names the phone service, database host or app host, except internal keys and paths', () => {
    const offenders: string[] = [];
    const swept = files.filter((f) => V7_SCREENS.some((p) => path.relative(SRC, f).replace(/\\/g, '/').startsWith(p)));
    expect(swept.length).toBeGreaterThan(40);
    for (const file of swept) {
      for (const { text, line } of textLiterals(file)) {
        if (!OTHER_VENDORS.test(text)) continue;
        if (INTERNAL_LITERAL.some((re) => re.test(text.trim()))) continue;
        offenders.push(`${path.relative(SRC, file)}:${line}  ${JSON.stringify(text.trim().slice(0, 80))}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('copy on the V7 screens writes its contractions with the curly apostrophe', () => {
    const offenders: string[] = [];
    // The shared contact and load-more files predate V7 and carry their own wording; they are not swept here.
    const own = V7_SCREENS.filter((p) => !p.startsWith('components/contact/') && p !== 'pages/v2/_shared/');
    for (const file of files.filter((f) => own.some((p) => path.relative(SRC, f).replace(/\\/g, '/').startsWith(p)))) {
      for (const { text, line } of textLiterals(file)) {
        if (/[A-Za-z]n't\b/.test(text) && text.includes(' ')) offenders.push(`${path.relative(SRC, file)}:${line}  ${JSON.stringify(text.trim().slice(0, 80))}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scanner itself sees a processor name in a label and ignores one in a comment', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 'sample.tsx');
    fs.writeFileSync(tmp, "// Stripe in a comment\nexport const a = 'Stripe fee';\nexport const B = () => <p>Paid via Stripe</p>;\n");
    const hits = textLiterals(tmp).filter((l) => VENDOR.test(l.text)).map((l) => l.text.trim());
    expect(hits).toEqual(['Stripe fee', 'Paid via Stripe']);
  });
});
