/**
 * "If empty, fill with" as the builder holds it - and the one rule that has to match the server
 * character for character, because this module decides what an author SEES in the box and
 * `backend/src/services/automations/mergeFieldFallbacks.ts` decides what the send actually
 * RENDERS. A disagreement here is a form that lies about what it is going to do.
 *
 * Written when the read became a MERGE (Ran, 2026-09-15). Until then nothing tested this file at
 * all, which is how the two sides could have drifted silently.
 */
import { describe, it, expect } from 'vitest';
import { displayedFallbacks, storedFallbacks } from './fallbacks';
import type { WorkflowCatalog } from '@/lib/api/workflows';

const catalog = {
  default_fallbacks: {
    'technician.names': 'Our team',
    'job.visit_location': 'the address we have on file for you',
    'org.phone': 'our office',
  },
} as unknown as WorkflowCatalog;

describe('displayedFallbacks', () => {
  it('shows the seeded defaults for a step that has never been touched', () => {
    expect(displayedFallbacks(undefined, catalog)).toEqual(catalog.default_fallbacks);
  });

  /**
   * THE SNAPSHOT CASE, and the reason this is a merge rather than `stored ?? defaults`.
   *
   * Every stored map is a snapshot of the defaults as they stood when it was written - the seeder
   * writes one into every seeded step, and this form emits the whole displayed map on the author's
   * first edit. Read as "stored wins outright", a default added later shows an EMPTY box for a
   * field that has one, and the server - which merges - then renders words the author was never
   * shown. The box would be lying about the send.
   */
  it('fills a gap a stored snapshot never had the chance to carry', () => {
    const snapshot = { 'technician.names': 'the crew' };

    expect(displayedFallbacks(snapshot, catalog)).toEqual({
      'technician.names': 'the crew',
      'job.visit_location': 'the address we have on file for you',
      'org.phone': 'our office',
    });
  });

  it('keeps a box the author deliberately cleared empty', () => {
    // Clearing stores the key with '' rather than deleting it (see sendEmailForm, which spreads
    // the displayed map and overwrites one key), so the merge cannot resurrect the default.
    expect(displayedFallbacks({ 'org.phone': '' }, catalog)['org.phone']).toBe('');
  });

  it('survives a catalog that has not loaded yet', () => {
    expect(displayedFallbacks(undefined, undefined)).toEqual({});
    expect(displayedFallbacks({ 'org.phone': 'the shop' }, undefined)).toEqual({ 'org.phone': 'the shop' });
  });
});

describe('storedFallbacks', () => {
  it('reads a map off the config and drops non-string values', () => {
    expect(storedFallbacks({ fallbacks: { a: 'x', b: 7 } })).toEqual({ a: 'x' });
  });

  // undefined, NOT {} - the difference is "this step has never been touched", which is what makes
  // the whole displayed map get emitted on the first edit rather than a single key.
  it('answers undefined for a config carrying no map, so an untouched step stays untouched', () => {
    expect(storedFallbacks({ body: 'b' })).toBeUndefined();
    expect(storedFallbacks({ fallbacks: 'nope' })).toBeUndefined();
    expect(storedFallbacks({ fallbacks: ['a'] })).toBeUndefined();
  });
});
