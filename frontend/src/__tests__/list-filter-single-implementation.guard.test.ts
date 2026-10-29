/* =============================================================================
   One list filter (mobile slice 64).

   Seven lists filter through one component, `pages/v2/_shared/filterPopover.tsx`: leads, customers
   and invoices since slice 51, and jobs, estimates, tasks and inventory since slice 64. Before it,
   each of the last four carried its own fork of the panel, and each fork was sized for a desktop
   window (a fixed 640 px panel and a 188 px rail) with no phone layout, so on a phone the filter
   left the screen.

   A fork is recognisable by the one thing every copy had to render: the facet rail,
   `aria-label="Filter facets"`. This fails when any source file but the shared one renders it, and
   when one of the seven list pages stops going through the shared component.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const V2 = join(SRC, 'pages', 'v2');
const SHARED = 'pages/v2/_shared/filterPopover.tsx';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file: string) => relative(SRC, file).split('\\').join('/');

describe('the list filter is one implementation', () => {
  it('only the shared component renders the facet rail in the v2 app', () => {
    const forks = sourceFiles(V2)
      .filter((file) => readFileSync(file, 'utf8').includes('aria-label="Filter facets"'))
      .map(rel);
    expect(forks).toEqual([SHARED]);
  });

  it.each([
    'leads/LeadsPage.tsx',
    'customers/CustomersPage.tsx',
    'invoices/InvoicesPage.tsx',
    'jobs/JobsPage.tsx',
    'estimates/EstimatesPage.tsx',
    'tasks/components/taskFilterBar.tsx',
    'inventory/components/inventoryFilter.tsx',
  ])('%s filters through the shared component', (file) => {
    const source = readFileSync(join(V2, file), 'utf8');
    expect(source).toMatch(/import \{[^}]*\bFilterPopover\b[^}]*\} from '(\.\.\/)+_shared\/filterPopover'/);
  });
});
