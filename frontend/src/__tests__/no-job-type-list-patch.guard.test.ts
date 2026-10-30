import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * V7-03c: a Job types entry is a row added through `POST /api/job-types`. No screen may rebuild the
 * list and send it back through the organization update (the server refuses that key).
 * V7-04 removes the last old Lists screen that still holds the list in its form state; this guard
 * only forbids the inline-add shape: an update call whose payload carries `job_type_options`.
 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

describe('job type list writes', () => {
  it('no screen sends job_type_options through an organization update', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src')).filter((file) =>
      /(mutate|mutateAsync|patch)\(\s*(?:'[^']*'\s*,\s*)?\{[^}]*job_type_options/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
