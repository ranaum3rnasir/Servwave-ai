/* =============================================================================
   #3022 entry-point guard: every read that feeds a lead's or a job's Communication tab.

   The tab lists the texts tied to the record plus the texts with the record's numbers from its creation until it closes
   (lib/communication/recordTextWindow.ts, proven over HTTP in record-communication-window-db.test.ts). The tab, the job
   Overview's recent-communications card and the email lookups on the estimate and invoice pages all read the two routes
   below; the tab carries no count or badge. This walks the source for every route serving a record's communications and
   every caller of the record aggregations, and each must be in the tables below: a new one fails here until it is
   classified. The tab's numbers (with the customer phone a record changed) are read by the tab's window only.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

const rel = (file: string) => relative(SRC, file).split('\\').join('/');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

/** Every route that answers a record's communications, and its handler. */
const ROUTES: Record<string, string> = {
  'routes/lead.routes.ts': 'getLeadCommunications', // the lead's Communication tab (#3022)
  'routes/job.routes.ts': 'getJobCommunications', // the job's Communication tab and Overview card (#3022)
  'routes/customer.routes.ts': 'getCustomerCommunications', // the customer's tab: not a lead or job, out of #3022
};

/** Every file that runs a lead's or a job's aggregation (lib/job-communications.ts). */
const AGGREGATION_CALLERS = ['controllers/job-communications.controller.ts'];

describe("every read that feeds a lead's or a job's Communication tab", () => {
  it('is a route in the table', () => {
    // Any registration (router or app, any method, any quote, any param name or full path) whose path ends in
    // `/communications`; the singular `/api/communication` section is another API.
    const found: Record<string, string> = {};
    for (const file of sourceFiles(SRC)) {
      const registrations = read(rel(file)).matchAll(/\.(?:get|post|put|patch|delete|all|use)\(\s*['"`][^'"`]*\/communications['"`]([^\n]*)/g);
      for (const m of registrations) found[rel(file)] = /\.(\w+)\)[;\s]*$/.exec(m[1]!)?.[1] ?? m[1]!;
    }
    expect(found).toEqual(ROUTES);
  });

  it("is run only from the table's callers", () => {
    const callers = sourceFiles(SRC)
      .filter((file) => !file.endsWith(join('lib', 'job-communications.ts')))
      .filter((file) => /from '[./]*(lib\/)?job-communications'/.test(readFileSync(file, 'utf8')))
      .filter((file) => /\b(getLeadCommunications|getJobCommunications)\b/.test(readFileSync(file, 'utf8')))
      .map(rel)
      .sort();
    expect(callers).toEqual(AGGREGATION_CALLERS);
  });

  it("hands both aggregations the texts with the record's numbers", () => {
    const source = read('controllers/job-communications.controller.ts');
    for (const kind of ['lead', 'job'] as const) {
      const aggregate = kind === 'lead' ? 'aggregateLeadCommunications' : 'aggregateJobCommunications';
      const handler = source.slice(source.indexOf(`export async function get${kind === 'lead' ? 'Lead' : 'Job'}Communications`));
      const body = handler.slice(0, handler.indexOf('\n}\n'));
      expect(body, kind).toMatch(new RegExp(`recordTextWindow\\(prisma, organizationId, \\{ kind: '${kind}', id \\}\\)`));
      expect(body.slice(body.indexOf(`${aggregate}(`)), kind).toMatch(/^\w+\(prisma, \{[^}]*\bwindowTexts,/);
    }
  });
  // Ran, 2026-11-06: the tab's numbers include a customer phone the record changed; a text sent from the record never goes
  // there (#3016 "changed for", #3018). So the tab's set is read by the tab's window only, never by a send.
  it("reads the tab's numbers only in the tab's window, never where a text sent from the record goes", () => {
    const readers = sourceFiles(SRC)
      .filter((file) => /\brecordTabNumbers\b/.test(readFileSync(file, 'utf8')))
      .map(rel)
      .sort();
    expect(readers).toEqual(['lib/communication/recordTextDestination.ts', 'lib/communication/recordTextWindow.ts']);
    const destination = read('lib/communication/recordTextDestination.ts');
    const send = destination.slice(destination.indexOf('export async function recordTextDestination('));
    expect(send).not.toMatch(/\brecordTabNumbers\b/);
  });
});
