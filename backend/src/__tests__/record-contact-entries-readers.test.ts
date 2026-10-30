/**
 * Roles & Permissions, PRD 5, slice S05.7 - a job-only phone or email takes no effect anywhere else.
 *
 * The documents, public pages, send recipients, automated messages and lists keep using the customer record
 * until the office review adds a value to the customer (PRD 6). The simplest way that stays true is that
 * nothing else reads the entries table, so this walks the source and names every file that does.
 */
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

/** The files that may touch the entries table. The job and lead pages read it; the pencil's endpoints write it. */
const MAY_READ = [
  'lib/record-contact-entries.ts',
  'controllers/record-contact-entries.controller.ts',
];

describe('who reads a job\'s or a lead\'s own contact entries', () => {
  it('is the entries module and its endpoint, and nothing that sends, prints or lists customer contacts', () => {
    const readers = sourceFiles(SRC)
      .filter((file) => /recordContactEntry|record_contact_entries/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
      .sort();

    expect(readers).toEqual([...MAY_READ].sort());
  });

  it('is shown on the job detail only through the entries module', () => {
    const controller = readFileSync(join(SRC, 'controllers/job.controller.ts'), 'utf8');
    expect(controller).toContain("from '../lib/record-contact-entries'");
    expect(controller).not.toMatch(/prisma\.recordContactEntry/);
  });

  it('is shown on the lead detail only through the entries module', () => {
    const controller = readFileSync(join(SRC, 'controllers/lead.controller.ts'), 'utf8');
    expect(controller).toContain("from '../lib/record-contact-entries'");
    expect(controller).not.toMatch(/prisma\.recordContactEntry/);
  });
});
