/**
 * Source-scanning guard: the standard-view drag wiring for a calendar entry (slice 08).
 *
 * WHY THIS EXISTS: `calendarEntryDrag.test.tsx` proves the member/technician grid's drop path
 * end-to-end by rendering the real page and firing a real `drop` event. It cannot do the same
 * for react-big-calendar's OWN internal drag-and-drop (the standard, non-grouped calendar view) —
 * `onEventDrop`/`onEventResize` fire from RBC's own pointer-event sequence, which a DOM test
 * cannot reliably synthesize (the plan doc's own "if a full react-big-calendar harness is too
 * expensive" clause). This file is the fallback the plan doc explicitly sanctions: "a
 * source-scanning guard is acceptable and has precedent in this repo".
 *
 * WHAT IT PROVES: the literal source text of `draggableAccessor`, `resizableAccessor`,
 * `handleEventDrop` and `handleEventResize` in SchedulePage.tsx contains the specific guard
 * clauses this slice's safety property depends on, IN THE RIGHT RELATIVE ORDER, AND with each
 * gating condition/return expression matched EXACTLY — not merely as a substring.
 *
 * QA CAUGHT A REAL HOLE HERE (post-ship review): the original version of this file matched
 * `ability.can('update', 'CalendarEntry')` as a bare substring with no end-of-expression anchor.
 * A mutation to `draggableAccessor` — `return ability.can('update', 'CalendarEntry') || true;`,
 * i.e. UNCONDITIONALLY ALLOWING THE DRAG regardless of the grant — still contains that exact
 * substring, so the old guard stayed green. `calendarEntryDrag.test.tsx` didn't catch it either:
 * it drives the member/technician grid's `handleMemberBoardDrop`, which never touches
 * `draggableAccessor` at all. My own manual check at the time only tried DELETING the gate line,
 * which the old substring guard correctly caught — that proved the guard detects removal, not
 * that it detects neutering, which is the failure mode that actually matters for a permission
 * check (a regression that silently GRANTS access, not one that removes a line).
 *
 * THE FIX: every gating `if`-statement below is extracted by balanced-paren parsing and compared
 * for EXACT string equality (after trimming whitespace) against its canonical condition/
 * then-clause — not `toMatch`. `|| true` appended to a return expression, `&& false` appended to
 * a guard condition, `false &&` prepended to one, or any other alteration all change the exact
 * text and fail the equality check. Extraction is anchor-based (find the nearest enclosing
 * `if (` before a unique substring, balanced-paren-walk to its close, then read up to the next
 * top-level `;`), so it does not depend on a fixed line range or brittle whitespace-sensitive
 * markers.
 *
 * WHAT IT STILL DOES NOT PROVE: that react-big-calendar actually calls these props the way the
 * JSX implies, or that CASL's `ability.can(...)` resolves correctly at runtime against a real
 * grant. This remains a source-reading regression trip-wire, not a behavioral proof.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, '../SchedulePage.tsx'), 'utf8');

/**
 * Extracts the braced body of an arrow function given a unique marker that appears BEFORE its
 * `=> {`. Finds the first `=> {` after the marker (skipping over any parameter destructuring or
 * type annotation, however many braces those contain — a fixed line range or a naive
 * brace-count from the marker itself would both break on `useCallback(({ a, b }: {...}) => {`'s
 * own parameter braces) and counts braces from THAT `{` until it closes. Survives reformatting
 * or reordering of unrelated code elsewhere in this (3900+ line) file.
 */
function extractArrowBody(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`"${marker}" not found in SchedulePage.tsx — has this prop/handler been renamed or removed?`);
  }
  const arrowIndex = source.indexOf('=> {', markerIndex);
  if (arrowIndex === -1) {
    throw new Error(`No "=> {" found after "${marker}" — has this become a non-arrow or single-expression function?`);
  }
  const openBraceIndex = arrowIndex + '=> '.length; // index of the body's opening '{'
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(openBraceIndex + 1, i);
    }
  }
  throw new Error(`"${marker}"'s body never closes — unbalanced braces?`);
}

/**
 * Finds the `if (` nearest to (and before) `anchor` within `body`, balanced-paren-walks to its
 * matching close paren to extract the CONDITION exactly, then reads from there to the next
 * top-level `;` to extract the THEN-CLAUSE exactly (covers both `if (cond) return;` and
 * `if (cond) return expr;` — the only two shapes this slice's guards use; neither wraps its
 * consequent in `{ }`, so "up to the next `;`" is unambiguous). Both strings are trimmed but
 * otherwise returned byte-for-byte, so the caller can assert exact equality rather than a
 * substring match — the fix for the hole QA found (see the file header).
 */
function extractIfClause(body: string, anchor: string): { condition: string; thenClause: string } {
  const anchorIndex = body.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(`anchor "${anchor}" not found in this body`);
  }
  const ifIndex = body.lastIndexOf('if (', anchorIndex);
  if (ifIndex === -1) {
    throw new Error(`no enclosing "if (" found before "${anchor}"`);
  }
  const condStart = ifIndex + 'if ('.length;
  let depth = 1;
  let i = condStart;
  for (; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || i >= body.length) {
    throw new Error(`unbalanced parens extracting the if-condition near "${anchor}"`);
  }
  const condition = body.slice(condStart, i).trim();
  const afterCond = body.slice(i + 1);
  const semiIndex = afterCond.indexOf(';');
  if (semiIndex === -1) {
    throw new Error(`no terminating ";" found for the then-clause near "${anchor}"`);
  }
  const thenClause = afterCond.slice(0, semiIndex).trim();
  return { condition, thenClause };
}

const ENTRY_TYPE_CONDITION = "e.type === 'calendar-entry'";
const ABILITY_RETURN = "return ability.can('update', 'CalendarEntry')";
const ABILITY_DENIED_CONDITION = "!ability.can('update', 'CalendarEntry')";
const BARE_RETURN = 'return';

describe('SchedulePage drag wiring — calendar entries (slice 08, source-scan guard)', () => {
  it('draggableAccessor gates a calendar entry on EXACTLY the CalendarEntry ability - no OR/AND appended or prepended', () => {
    const body = extractArrowBody(SOURCE, 'draggableAccessor={(event: object)');
    const { condition, thenClause } = extractIfClause(body, "'calendar-entry'");
    expect(condition).toBe(ENTRY_TYPE_CONDITION);
    expect(thenClause).toBe(ABILITY_RETURN);
  });

  it('resizableAccessor gates a calendar entry on EXACTLY the CalendarEntry ability - no OR/AND appended or prepended', () => {
    const body = extractArrowBody(SOURCE, 'resizableAccessor={(event: object)');
    const { condition, thenClause } = extractIfClause(body, "'calendar-entry'");
    expect(condition).toBe(ENTRY_TYPE_CONDITION);
    expect(thenClause).toBe(ABILITY_RETURN);
  });

  it('handleEventDrop branches on calendar-entry and returns BEFORE the job-shaped RescheduleConfirmDialog path', () => {
    const body = extractArrowBody(SOURCE, 'const handleEventDrop = useCallback(');
    const branchIndex = body.search(/event\.type\s*===\s*['"]calendar-entry['"]/);
    // handleEventDrop's own job/walkthrough fallback never calls a mutation directly - it opens
    // RescheduleConfirmDialog (setRescheduleConfirm), which is exactly the dialog the spec says
    // an entry must never see ("no RescheduleConfirmDialog, no crew prompt").
    const fallbackIndex = body.indexOf('setRescheduleConfirm(');
    expect(branchIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(-1);
    // Order matters: a job-fallback call reachable BEFORE the entry branch is the misroute.
    expect(branchIndex).toBeLessThan(fallbackIndex);
    // And that branch must actually exit - a fall-through would still reach the code below it.
    expect(body).toMatch(/calendar-entry['"]\s*\)\s*\{[\s\S]{0,300}?return;/);
    // The belt-and-braces ability check INSIDE that branch, matched exactly (same hole class as
    // draggableAccessor above: this line is never exercised by any render-based test, since it
    // only runs on react-big-calendar's own onEventDrop, not the grid's handleMemberBoardDrop).
    const { condition, thenClause } = extractIfClause(body, 'ability.can(');
    expect(condition).toBe(ABILITY_DENIED_CONDITION);
    expect(thenClause).toBe(BARE_RETURN);
  });

  it('handleEventResize branches on calendar-entry and returns BEFORE the job-fallback mutation', () => {
    const body = extractArrowBody(SOURCE, 'const handleEventResize = useCallback(');
    const branchIndex = body.search(/event\.type\s*===\s*['"]calendar-entry['"]/);
    const fallbackIndex = body.indexOf('moveJobEvent(');
    expect(branchIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(-1);
    expect(branchIndex).toBeLessThan(fallbackIndex);
    expect(body).toMatch(/calendar-entry['"]\s*\)\s*\{[\s\S]{0,300}?return;/);
    const { condition, thenClause } = extractIfClause(body, 'ability.can(');
    expect(condition).toBe(ABILITY_DENIED_CONDITION);
    expect(thenClause).toBe(BARE_RETURN);
  });

  it('handleMemberBoardDrop (member/technician grid) also branches on calendar-entry, gated on EXACTLY the CalendarEntry ability', () => {
    const body = extractArrowBody(SOURCE, 'const handleMemberBoardDrop = (');
    expect(body).toMatch(/parsed\.kind\s*===\s*['"]calendar-entry['"]/);
    const { condition, thenClause } = extractIfClause(body, 'ability.can(');
    expect(condition).toBe(ABILITY_DENIED_CONDITION);
    expect(thenClause).toBe(BARE_RETURN);
  });

  // ─── Plan Mode exclusion (§3) — ASSERTED, not left structural-only ──
  //
  // Slice 03/RECON: Plan Mode's exclusion of calendar entries was structural (every `addGhost`
  // call site was drag-gated or filtered on `bucketEvents`, which entries never enter) rather
  // than asserted by a test. These two checks pin the ORDERING that makes it still true now that
  // drag is turned on: in the standard view, the calendar-entry branch must run BEFORE the
  // `planMode.isActive` ghost-creation block, or a drag would create a ghost for an entry. In the
  // member/technician grid, it is the OPPOSITE order — `planMode.isActive` must be checked FIRST,
  // because that block itself is what returns early for a non-bucket-job drop and keeps the
  // calendar-entry branch below it unreached while Plan Mode is active.
  it('standard view: the calendar-entry branch in handleEventDrop runs BEFORE the Plan Mode ghost block', () => {
    const body = extractArrowBody(SOURCE, 'const handleEventDrop = useCallback(');
    const entryBranchIndex = body.search(/event\.type\s*===\s*['"]calendar-entry['"]/);
    const planModeIndex = body.indexOf('planMode.isActive');
    expect(entryBranchIndex).toBeGreaterThan(-1);
    expect(planModeIndex).toBeGreaterThan(-1);
    expect(entryBranchIndex).toBeLessThan(planModeIndex);
  });

  it('standard view: the calendar-entry branch in handleEventResize runs BEFORE the Plan Mode ghost block', () => {
    const body = extractArrowBody(SOURCE, 'const handleEventResize = useCallback(');
    const entryBranchIndex = body.search(/event\.type\s*===\s*['"]calendar-entry['"]/);
    const planModeIndex = body.indexOf('planMode.isActive');
    expect(entryBranchIndex).toBeGreaterThan(-1);
    expect(planModeIndex).toBeGreaterThan(-1);
    expect(entryBranchIndex).toBeLessThan(planModeIndex);
  });

  it('member/technician grid: the Plan Mode block in handleMemberBoardDrop runs BEFORE the calendar-entry branch', () => {
    const body = extractArrowBody(SOURCE, 'const handleMemberBoardDrop = (');
    const planModeIndex = body.indexOf('planMode.isActive');
    const entryBranchIndex = body.search(/parsed\.kind\s*===\s*['"]calendar-entry['"]/);
    expect(planModeIndex).toBeGreaterThan(-1);
    expect(entryBranchIndex).toBeGreaterThan(-1);
    // Opposite order from the standard view - see the block comment above.
    expect(planModeIndex).toBeLessThan(entryBranchIndex);
  });
});
