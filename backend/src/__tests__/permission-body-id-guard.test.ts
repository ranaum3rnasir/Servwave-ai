/* =============================================================================
   Roles & Permissions security fixes, ticket 33 (spec story 47): no request field that names a record goes unchecked.

   A source guard. It reads every request schema (`<field>: z…`), every `req.body.<field>` and every query-string read
   (`req.query.<field>`, destructured or through an alias) in the backend for fields
   that name a record with reach, and requires each to be COVERED by a database row proving a record out of reach answers
   exactly like a missing one, or ALLOWED with its reason (permission-body-id-doors.ts). A new field that is neither fails
   here, so the next door that takes a record id in its body cannot ship unchecked.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { ALLOWED, ALLOWED_FILES, COVERED, RECORD_ID_BODY_READ, RECORD_ID_FIELD, RECORD_ID_NAME, RECORD_ID_QUERY_READ } from './permission-body-id-doors';

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' || name === 'copilot' ? [] : sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

const DECLARATION = /(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/;

/** Every body id field in the backend, as `<file>#<schema const>.<field>` or `<file>#req.body.<field>`. */
function bodyIdFields(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = line.split('//')[0]!;
      if (code.trim().startsWith('*')) return;
      for (const m of code.matchAll(RECORD_ID_FIELD)) {
        let schema = '?';
        for (let j = i; j >= 0; j -= 1) {
          const d = DECLARATION.exec(lines[j]!);
          if (d) { schema = d[1]!; break; }
        }
        found.add(`${rel}#${schema}.${m[1]}`);
      }
      for (const m of code.matchAll(RECORD_ID_BODY_READ)) found.add(`${rel}#req.body.${m[1]}`);
      for (const m of code.matchAll(RECORD_ID_QUERY_READ)) found.add(`${rel}#req.query.${m[1]}`);
    });
    // Query-string ids read by destructuring (`const { a, job_id } = req.query`) or through an alias
    // (`const q = req.query as …; q.job_id`), single or multi-line.
    const text = lines.join('\n');
    for (const m of text.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*\(?\s*req\.query\b/g)) {
      for (const part of m[1]!.split(',')) {
        const name = part.trim().split(/[:=\s]/)[0]!;
        if (name && RECORD_ID_NAME.test(name)) found.add(`${rel}#req.query.${name}`);
      }
    }
    for (const m of text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*req\.query\b/g)) {
      for (const f of text.matchAll(new RegExp(`\\b${m[1]}\\??\\.([A-Za-z_]\\w*)`, 'g'))) {
        if (RECORD_ID_NAME.test(f[1]!)) found.add(`${rel}#req.query.${f[1]}`);
      }
    }
  }
  return [...found].sort();
}

describe('every request field that names a record is checked for reach, or named with its reason', () => {
  const fields = bodyIdFields();
  const fileOf = (key: string) => key.slice(0, key.indexOf('#'));

  it('finds the body id fields (the scan works)', () => {
    expect(fields.length).toBeGreaterThan(50);
    expect(fields).toContain('src/controllers/invoice.controller.ts#createInvoiceSchema.job_id');
  });

  it('has no body id field that is neither covered by a reach row nor allowed with a reason', () => {
    const unclassified = fields.filter((k) => !COVERED[k] && !ALLOWED[k] && !ALLOWED_FILES[fileOf(k)]);
    expect(unclassified).toEqual([]);
  });

  it('lists nothing that no longer exists, so the list stays the truth', () => {
    const stale = [...Object.keys(COVERED), ...Object.keys(ALLOWED)].filter((k) => !fields.includes(k));
    expect(stale).toEqual([]);
  });

  it('gives every allowed field a reason', () => {
    for (const [k, why] of [...Object.entries(ALLOWED), ...Object.entries(ALLOWED_FILES)]) expect(why.trim().length, k).toBeGreaterThan(10);
  });
});
