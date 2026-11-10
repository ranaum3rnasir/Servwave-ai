/* =============================================================================
   #3022 entry-point guard: every place in the app that reads a lead's or a job's communications.

   The server lists, on both reads, the texts tied to the record plus the texts with the numbers its card shows from its
   creation until it closes. Every reader below gets that list; none counts or badges it. The two Communication tabs read
   it through their hooks, and those reads follow the card: a pencil write reads them again (recordContactEntries.ts).

   This walks the source for every file that asks for `/api/leads/<id>/communications` or `/api/jobs/<id>/communications`,
   and each must be in the table below. A new reader fails here until it is classified.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A file reads a record's communications when any line asks for a `/communications` path that is not plainly a customer's:
 * a lead's, a job's, or a record named at run time (`/api/${kind}s/${id}/communications`, `'/api/leads/' + id +
 * '/communications'`). The singular `/api/communication/...` section is another API. Comment lines name the route, they
 * do not read it.
 */
function readsRecordCommunications(source: string): boolean {
  return source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .some((line) => /\/communications(?![\w-])/.test(line) && !/\/customers\//.test(line));
}

const READERS: Record<string, string> = {
  // useLeadCommunications and useJobCommunications: the two Communication tabs, and the email lookups on the estimate and
  // invoice pages (emails only).
  'lib/api/jobCommunications.ts': 'TAB_HOOKS',
  // The job Overview's "recent communications": the newest three rows of the job's read.
  'components/jobs/overview/CustomerContactCard.tsx': 'OVERVIEW_PREVIEW',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("every place that reads a lead's or a job's communications", () => {
  it('is classified in the table', () => {
    const readers = sourceFiles(SRC)
      .filter((file) => readsRecordCommunications(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split('\\').join('/'))
      .sort();
    expect(readers).toEqual(Object.keys(READERS).sort());
  });

  it('the two tabs take their list from the hooks', () => {
    const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
    expect(read('components/communication/LeadCommunicationsTab.tsx')).toMatch(/useLeadCommunications\(leadId\)/);
    expect(read('components/communication/JobCommunicationsTab.tsx')).toMatch(/useJobCommunications\(jobId\)/);
  });
});
