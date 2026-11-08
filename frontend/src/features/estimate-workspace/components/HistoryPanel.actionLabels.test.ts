/**
 * #2091 — the History drawer must never render a raw event code (e.g. `estimate.line_added`)
 * because `ACTION_LABELS` forgot to list it.
 *
 * This reads the BACKEND source directly — the idiom in `upload-limits-match-backend.test.ts` —
 * rather than hand-maintaining a second copy of the action list here. A hand-maintained list is
 * exactly the shape of guard that let the four actions from the QA report (`line_added`,
 * `line_updated`, `scope_added`, `deposit_repriced`) go unlabelled in the first place: nothing
 * failed when the backend grew a new `estimate.*` audit action, because nothing compared the two
 * trees. Every `logAudit({ ..., action: 'estimate.X', resourceType: 'Estimate', ... })` call
 * anywhere in `backend/src` is collected and checked against `ACTION_LABELS`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ACTION_LABELS } from './HistoryPanel';

/** Repo root — this file sits at frontend/src/features/estimate-workspace/components/. */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const BACKEND_SRC = join(ROOT, 'backend', 'src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'copilot') continue; // Servy is not live — see CLAUDE.md.
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `logAudit({...})` call's raw argument text, brace/paren-depth matched so a nested
 * `metadata: { ... }` object inside the call does not truncate the match early.
 */
function logAuditCallBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = 'logAudit(';
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    const argsStart = start + marker.length;
    let depth = 1;
    let i = argsStart;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    bodies.push(source.slice(argsStart, i - 1));
    searchFrom = i;
  }
  return bodies;
}

/** Every `estimate.*` action logged anywhere with `resourceType: 'Estimate'`, deduped. */
function estimateActionsLoggedByBackend(): Set<string> {
  const actions = new Set<string>();
  for (const file of listSourceFiles(BACKEND_SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const body of logAuditCallBodies(source)) {
      const resourceType = /resourceType:\s*'([^']+)'/.exec(body)?.[1];
      const action = /action:\s*'([^']+)'/.exec(body)?.[1];
      if (resourceType === 'Estimate' && action?.startsWith('estimate.')) {
        actions.add(action);
      }
    }
  }
  return actions;
}

describe('the History drawer labels every estimate audit action', () => {
  it('lists a plain-English label for every `resourceType: \'Estimate\'` action the backend logs', () => {
    const backendActions = [...estimateActionsLoggedByBackend()].sort();

    // A sanity floor, so a regex that stops matching (a refactor of logAudit's call shape,
    // a rename) fails LOUD as "found nothing" rather than silently passing an empty list.
    expect(backendActions.length).toBeGreaterThan(20);

    const unlabelled = backendActions.filter((action) => !(action in ACTION_LABELS));
    expect(unlabelled).toEqual([]);
  });
});
