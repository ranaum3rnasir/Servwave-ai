/**
 * manual-log-silence.ts — the shared spy assertion for the Manual Communication Log's SILENCE
 * (spec: md_files/specs/communication/2026-08-27-manual-communication-log.md, slice 9).
 *
 * TEST SUPPORT, not a test. It lives here so that every path of the feature — create today,
 * update and delete when slice 8 lands — asserts the silence the SAME way, against the SAME two
 * seams, rather than each suite inventing its own and one of them quietly asserting nothing.
 *
 * WHY A SPY AND NOT AN ABSENCE OF SIDE EFFECTS. An admin backfilling months of history may create
 * hundreds of entries in an afternoon, and not one of them may dispatch an automation or raise a
 * notification. A test that concludes "nothing happened" from an empty notifications list is a
 * placebo: it stays green after somebody wires the dispatcher in, because the dispatcher is
 * fire-and-forget (`setImmediate`) and mocked-out downstream, so nothing observable would change.
 * Only a spy on the dispatcher itself can fail in that world.
 *
 * ── HOW TO USE IT (slice 8: this is the contract your update/delete suites must meet) ──────────
 *
 * At the TOP of your test file, before any other import that reaches the controller:
 *
 *     vi.mock('../services/notifications/notificationService', () => ({
 *       emit: vi.fn().mockResolvedValue([]),
 *     }));
 *
 * then in `beforeEach`, AFTER whatever clearAllMocks/resetAllMocks you run:
 *
 *     armSilenceSpies();
 *
 * and immediately after each request whose silence you are asserting:
 *
 *     expectNothingWokenUp();
 *
 * ── WHY THE SPIES SURVIVE OTHER SUITES' MOCK HYGIENE ──────────────────────────────────────────
 *
 * `vi.resetAllMocks()` has already broken a fixture default once on this feature, so:
 *
 *   - Both seams are replaced at the MODULE level (`vi.mock`), which `clearAllMocks` and
 *     `resetAllMocks` do not undo — they reset a mock's state, they do not restore the real
 *     module. `dispatchAutomationEvent` is mocked globally in setup.ts; `emit` is mocked by the
 *     importing file, because mocking it globally would change ~20 unrelated suites.
 *   - `expectNothingWokenUp` asserts only CALL HISTORY, never a return value, so a reset that
 *     wipes an implementation cannot change its verdict.
 *   - `armSilenceSpies` re-arms `emit`'s resolved value, so a reset cannot leave a caller
 *     awaiting `undefined` in some future version of the controller.
 *   - `assertSpiesArmed` FAILS LOUDLY if either seam is not a mock. That is the whole point: a
 *     suite that forgot the `vi.mock` above would otherwise assert `not.toHaveBeenCalled()`
 *     against the real function and pass for the wrong reason.
 */
import { expect, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { dispatchAutomationEvent } from '../services/automations/dispatch';
import { emit } from '../services/notifications/notificationService';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrisma = prisma as any;

function assertSpiesArmed(): void {
  if (!vi.isMockFunction(dispatchAutomationEvent)) {
    throw new Error(
      'manual-log-silence: dispatchAutomationEvent is not a mock. setup.ts mocks ' +
        "'../services/automations/dispatch' globally — restore that, or re-mock it in this file.",
    );
  }
  if (!vi.isMockFunction(emit)) {
    throw new Error(
      'manual-log-silence: notificationService.emit is not a mock, so asserting it was never ' +
        "called proves nothing. Add vi.mock('../services/notifications/notificationService', " +
        '() => ({ emit: vi.fn().mockResolvedValue([]) })) to the top of this test file.',
    );
  }
}

/** Call in `beforeEach`, after clearAllMocks/resetAllMocks. */
export function armSilenceSpies(): void {
  assertSpiesArmed();
  (emit as any).mockResolvedValue([]);
}

/**
 * Nothing was woken up by the request that just ran.
 *
 * The two module spies are the assertion the acceptance criteria name. The two prisma assertions
 * are a second, independent net: they catch a future wiring that reaches the Automation Center or
 * the notification tables WITHOUT going through either seam, which the module spies would miss.
 */
export function expectNothingWokenUp(): void {
  assertSpiesArmed();
  expect(dispatchAutomationEvent).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
  expect(mockPrisma.notificationRecipient.create).not.toHaveBeenCalled();
  expect(mockPrisma.notificationRecipient.createMany).not.toHaveBeenCalled();
  expect(mockPrisma.automationRun.create).not.toHaveBeenCalled();
  expect(mockPrisma.automationRun.createMany).not.toHaveBeenCalled();
}
