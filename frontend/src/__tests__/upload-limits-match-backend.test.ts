/**
 * The client's copy of the upload rules, checked against the server's actual source.
 *
 * This replaces a test that asserted the frontend literals equalled 25MB and 50MB. That guard
 * fired in the safe direction and stayed silent in the dangerous one, which is worse than no
 * guard because it reads as coverage:
 *
 *   - someone raises the FRONTEND constant and forgets the test -> red immediately, though
 *     nothing is broken yet;
 *   - the BACKEND cap is raised and the frontend is forgotten -> both suites green, while
 *     the client silently refuses every video between the old cap and the new one that the
 *     API would now accept. That is the raise undone on the client with nothing failing.
 *     It is not hypothetical: the video cap went 50MB -> 512MB on 2026-09-20.
 *
 * Reading both trees is the only shape that catches the second case. The idiom (and the
 * fail-loudly-on-no-match rule below) is lifted from `selfOnlyRefusalCopy.test.ts`.
 *
 * `DIRECT_UPLOAD_MIME_TYPES` is here for the same reason: `uploadAttachment.ts` carries an
 * identical "MUST stay in step with" contract, and if the client list gets ahead the mint
 * call 400s and the upload fails outright.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  DIRECT_UPLOAD_MIME_TYPES,
  ACCEPTED_UPLOAD_MIME_TYPES,
} from '@/lib/uploadTypes';

/** Repo root - this file sits at frontend/src/__tests__/. */
const ROOT = join(__dirname, '..', '..', '..');
const CONTROLLER_PATH = 'backend/src/controllers/attachment.controller.ts';
const CONTROLLER = readFileSync(join(ROOT, CONTROLLER_PATH), 'utf8');

/**
 * `export const NAME = 25 * 1024 * 1024;` -> 26214400.
 *
 * Throws rather than returning undefined when it matches nothing: a renamed or restructured
 * constant must turn this RED, not quietly compare against nothing.
 */
function byteConst(name: string): number {
  const match = new RegExp(`const ${name} = (\\d+) \\* 1024 \\* 1024;`).exec(CONTROLLER);
  if (!match) {
    throw new Error(
      `Could not find \`const ${name} = N * 1024 * 1024\` in ${CONTROLLER_PATH}. If it was ` +
        'renamed, moved or rewritten, update this test - do not delete it: it is the only ' +
        'check that reads both trees.'
    );
  }
  return Number(match[1]) * 1024 * 1024;
}

function mimeListConst(name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([^\\]]+)\\];`).exec(CONTROLLER);
  if (!match) {
    throw new Error(
      `Could not find \`const ${name} = [...]\` in ${CONTROLLER_PATH}. If it was renamed or ` +
        'restructured, update this test - do not delete it.'
    );
  }
  return match[1]!
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

describe('client upload limits mirror the server', () => {
  it('matches MAX_FILE_SIZE', () => {
    expect(MAX_UPLOAD_BYTES).toBe(byteConst('MAX_FILE_SIZE'));
  });

  it('matches MAX_VIDEO_FILE_SIZE', () => {
    expect(MAX_VIDEO_UPLOAD_BYTES).toBe(byteConst('MAX_VIDEO_FILE_SIZE'));
  });

  it('matches DIRECT_UPLOAD_MIME_TYPES', () => {
    expect([...DIRECT_UPLOAD_MIME_TYPES].sort()).toEqual(
      mimeListConst('DIRECT_UPLOAD_MIME_TYPES').sort()
    );
  });

  // Slice 13: the New Task dialog refuses a type before create with this list, so it must be
  // the server's list exactly - a client list SHORTER than the server's refuses files the API
  // would take. The controller's array carries comments, so only the quoted entries are read.
  it('matches ALLOWED_MIME_TYPES', () => {
    const match = /const ALLOWED_MIME_TYPES = \[([^\]]+)\];/.exec(CONTROLLER);
    if (!match) throw new Error(`Could not find \`const ALLOWED_MIME_TYPES = [...]\` in ${CONTROLLER_PATH}.`);
    const server = match[1]!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
      .match(/'[^']+'/g)!
      .map((q) => q.slice(1, -1));
    expect(server.length).toBeGreaterThan(5);
    expect([...ACCEPTED_UPLOAD_MIME_TYPES].sort()).toEqual(server.sort());
  });
});
