// What the phone code ships to the browser with the vendor's name in it.
//
// Vendor names may appear in backend code and logs only; the JavaScript bundle is
// reachable by anyone (view-source, dev tools), so a vendor-named string in our
// own browser code is a vendor name in front of the user. The ONLY ones allowed
// are the vendor's contract - strings its code requires us to use verbatim.
//
// This reads the phone modules' source with the TypeScript parser and collects
// every piece of it that survives minification: string and template literals,
// regular expressions, property names in `a.b` accesses and object literal keys.
// Comments and local identifiers are stripped or renamed by the build, so they
// are not collected. Every collected piece mentioning the vendor must be on the
// contract list below.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIR = path.resolve(__dirname, '..');
const VENDOR = /ctm|calltracking/i;

/** The vendor's contract: required verbatim by its code, so it must stay. */
const VENDOR_CONTRACT = new Set([
  // Its script, and the origin its frames post messages from.
  'https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js',
  'https://app.calltrackingmetrics.com',
  // Its custom element tag names (created by us, or appended by its code and
  // matched by our hide rule).
  'ctm-phone-embed',
  'ctm-device-embed',
  // Its element's DOM events.
  'ctm:requiresToken',
  'ctm:ready',
  'ctm:start',
  'ctm:answer',
  'ctm:end-activity',
  'ctm:hangup',
  'ctm:incomingCall',
  // The actions its device frame posts to our window.
  'ctm.device.locked_in',
  'ctm.device.locked_out',
  'ctm.device.inline_ready',
]);

function shippedStrings(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    // Module specifiers are resolved and bundled away; they never ship.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text);
    } else if (ts.isRegularExpressionLiteral(node)) {
      out.push(node.text);
    } else if (ts.isPropertyAccessExpression(node)) {
      // `import.meta.env.X` is replaced by its value at build time; X never ships.
      if (node.expression.getText(source) !== 'import.meta.env') out.push(node.name.text);
    } else if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && ts.isIdentifier(node.name)) {
      // Only object-literal keys survive minification; class members are not used here.
      if (ts.isObjectLiteralExpression(node.parent)) out.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const phoneModules = readdirSync(DIR)
  .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f))
  .map((f) => path.join(DIR, f));

describe('phone code ships no vendor name except the vendor contract', () => {
  it('scans the phone modules (sanity: the device wrapper is among them)', () => {
    expect(phoneModules.map((f) => path.basename(f))).toContain('ctmSoftphone.ts');
    expect(phoneModules.map((f) => path.basename(f))).toContain('vendorConsoleFilter.ts');
  });

  it.each(phoneModules.map((f) => [path.basename(f), f]))('%s', (_name, file) => {
    const offenders = shippedStrings(file).filter((s) => VENDOR.test(s) && !VENDOR_CONTRACT.has(s));
    expect(offenders).toEqual([]);
  });
});
