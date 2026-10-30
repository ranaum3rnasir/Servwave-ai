/* =============================================================================
   Roles & Permissions S07.23 - no inventory screen reads a role's name. Zero tolerance, not a ratchet.

   The field roster ("field technician" versus counter) comes from the server's answer to the Inventory view
   switch, and the van stock limit is the server's answer to Restrict stock to own van. A screen that compares a
   person's role with a name would send a custom role down the wrong path, so none may.

   WHAT COUNTS. Matched on the syntax tree, so a comment or a doc string that talks about a role does not trip it:
     - a string or template literal that IS a built-in role key (TECHNICIAN, DISPATCHER, SALES, ADMIN) or a
       roster tag from the old staff answer (field_tech, warehouse_lead, subcontractor);
     - a read of a role field (`.role`, `.base_role`, `.custom_role`, `.roleName`, `.based_on_role_key`);
     - an identifier named for a role test (isTech, isTechnician, isAdmin, isDispatcher, isSales).
   Showing a role's label is not reading it for a rule, and none of the screens here show one.

   ONE ALLOWED READ. A vendor's contact has a free-form `role` that is a job title ("Orders rep", "AP"), not a
   person's account role. The two vendor dialogs read it as `c.role`, `x.role` or `y.role` on a contact.

   SCOPE. Every file the Inventory routes render, the job page's stock and order sections, and the data seam
   they read. Tests and stories are skipped. A new file under these folders is covered without being listed.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Folders and files under src/, forward slashes. */
const SCOPE = [
  'pages/v2/inventory',
  'pages/inventory',
  'components/inventory',
  'lib/inventory',
  'lib/api/_mock/inventory',
  'lib/api/inventory.ts',
  'lib/api/logisticOrders.ts',
  'components/jobs/JobStagesSection.tsx',
  'pages/v2/_shared/loList.tsx',
  'pages/v2/_shared/materialLines.tsx',
];

const ROLE_KEYS = new Set(['TECHNICIAN', 'DISPATCHER', 'SALES', 'ADMIN', 'field_tech', 'warehouse_lead', 'subcontractor']);
const ROLE_FIELDS = new Set(['role', 'base_role', 'custom_role', 'roleName', 'based_on_role_key']);
/** Where `.role` is a vendor contact's job title, and the names the contact goes by there. */
const CONTACT_TITLE_FILES = ['components/inventory/AddVendorDialog.tsx', 'components/inventory/VendorDetailDialog.tsx'];
const CONTACT_NAMES = new Set(['c', 'x', 'y']);
const ROLE_TESTS = new Set(['isTech', 'isTechnician', 'isAdmin', 'isDispatcher', 'isSales']);

function isTestOrStory(file: string): boolean {
  return /(__tests__|\.test\.|\.stories\.|\.guard\.)/.test(file);
}

function filesUnder(path: string): string[] {
  const abs = join(SRC, path);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const child = join(path, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : filesUnder(child);
    return /\.(ts|tsx)$/.test(e.name) && !isTestOrStory(e.name) ? [join(SRC, child)] : [];
  });
}

/** Every role-name read in one source text, as "line: text". */
export function roleNameReads(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  const isContactTitle = (node: ts.PropertyAccessExpression) =>
    CONTACT_TITLE_FILES.some((f) => file.endsWith(f)) &&
    node.name.text === 'role' &&
    ts.isIdentifier(node.expression) &&
    CONTACT_NAMES.has(node.expression.text);
  const note = (node: ts.Node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    hits.push(`${line + 1}: ${node.getText().slice(0, 60)}`);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && ROLE_KEYS.has(node.text)) note(node);
    if (ts.isPropertyAccessExpression(node) && ROLE_FIELDS.has(node.name.text) && !isContactTitle(node)) note(node);
    if (ts.isIdentifier(node) && ROLE_TESTS.has(node.text)) note(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

describe('no inventory screen reads a role name (S07.23)', () => {
  const files = SCOPE.flatMap(filesUnder);

  it('scans the inventory screens (the guard is not looking at an empty folder)', () => {
    expect(files.length).toBeGreaterThan(60);
    expect(files.some((f) => f.endsWith('pages/v2/inventory/InventoryPage.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('components/inventory/AddLocationDialog.tsx'))).toBe(true);
  });

  it('finds a role comparison when one is there', () => {
    expect(roleNameReads('a.tsx', `const x = people.filter((t) => t.role === "field_tech");`)).toHaveLength(2);
    expect(roleNameReads('a.tsx', `const x = user.base_role === 'TECHNICIAN';`)).toHaveLength(2);
    expect(roleNameReads('a.tsx', `const x = isTechnician(user);`)).toHaveLength(1);
    expect(roleNameReads('a.tsx', `// a SALES person\nconst x = 'Counter';`)).toHaveLength(0);
  });

  it('has no role-name comparison on any of them', () => {
    const offenders = files.flatMap((f) => roleNameReads(f, readFileSync(f, 'utf8')).map((h) => `${relative(SRC, f)}:${h}`));
    expect(offenders).toEqual([]);
  });
});
