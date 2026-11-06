/* =============================================================================
   Every Spider email carries the record it belongs to (#2997): a source-driven guard.

   The provider's delivery events find a Spider record only through the tag a send carries
   (services/spider/emailEvents.ts). So every Spider email must go out through the one send in
   delivery.ts, which tags it. This reads the Spider source itself, so a second way to send an email
   added later (a new provider call, or a shared email helper used from a Spider file) fails here.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const SPIDER_DIR = join(__dirname, '..', 'services', 'spider');
const sources = readdirSync(SPIDER_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(SPIDER_DIR, f), 'utf8') }));

/** What a Spider file may take from the shared email module: the client for the one send, and pure formatters. */
const ALLOWED_FROM_EMAIL_MODULE = new Set(['esc', 'formatSenderIdentity', 'resend', 'wrapHtml']);

describe('every Spider email is sent tagged with its record', () => {
  it('reads the Spider source (the guard is not looking at an empty folder)', () => {
    expect(sources.map((s) => s.file)).toEqual(expect.arrayContaining(['delivery.ts', 'sweep.ts', 'summary.ts', 'emailEvents.ts']));
  });

  it('has exactly one provider send, in delivery.ts, and it carries the record tags', () => {
    const sends = sources.flatMap((s) => [...s.text.matchAll(/emails\.send\s*\(/g)].map((m) => ({ file: s.file, at: m.index! })));
    expect(sends.map((s) => s.file)).toEqual(['delivery.ts']);
    const delivery = sources.find((s) => s.file === 'delivery.ts')!.text;
    const call = delivery.slice(sends[0].at, delivery.indexOf('});', sends[0].at));
    expect(call).toMatch(/tags:\s*spiderEmailTags\(record\)/);
  });

  it('takes nothing else from the shared email module, so no other email helper can send a Spider email untagged', () => {
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'[./]*lib\/email'/g)) {
        const names = m[1].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean);
        for (const name of names) expect({ file, name, allowed: ALLOWED_FROM_EMAIL_MODULE.has(name) }).toEqual({ file, name, allowed: true });
      }
      expect({ file, defaultOrStar: /import\s+(\*\s+as\s+\w+|\w+)\s+from\s*'[./]*lib\/email'/.test(text) }).toEqual({ file, defaultOrStar: false });
    }
  });
});
