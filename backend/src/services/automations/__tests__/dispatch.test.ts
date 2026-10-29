/**
 * dispatch.test.ts — dispatchAutomationEvent routes events into the multi-step
 * workflow engine (enrollment.ts) and NEVER lets a failure reach the caller.
 *
 * The controller→dispatch wiring (which events fire, with what shape) is covered
 * by automation-wiring.test.ts; this suite pins dispatch's own contract:
 * fire-and-forget via setImmediate, delegate to enrollOnEvent, swallow + log.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { logger } from '../../../lib/logger';
import type { AutomationEvent, EventTriggerType } from '../dispatch';

vi.mock('../enrollment', () => ({
  enrollOnEvent: vi.fn(),
}));
import { enrollOnEvent } from '../enrollment';

// dispatch is globally mocked in setup.ts (its setImmediate fire-and-forget
// would otherwise run AFTER unrelated tests and pollute their mock call counts).
// Load the REAL module here so we can assert its wiring; importActual keeps the
// module's own deps (enrollment, logger) resolving to the mocks above.
let dispatchAutomationEvent: typeof import('../dispatch').dispatchAutomationEvent;

const mockEnroll = enrollOnEvent as ReturnType<typeof vi.fn>;
const mockWarn = logger.warn as ReturnType<typeof vi.fn>;

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Typed against the exported surface: proves AutomationEvent + EventTriggerType
// are still exported (tsc fails here if either is removed/renamed).
const TRIGGER: EventTriggerType = 'JOB_COMPLETED';
const EV: AutomationEvent = {
  type: TRIGGER,
  organizationId: '00000000-0000-0000-0000-000000000001',
  entity: { type: 'job', id: 'b0000000-0000-0000-0000-000000000001', label: 'J00001' },
};

beforeAll(async () => {
  ({ dispatchAutomationEvent } = await vi.importActual<typeof import('../dispatch')>('../dispatch'));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatchAutomationEvent', () => {
  it('defers to the next tick, then routes the event into enrollOnEvent', async () => {
    mockEnroll.mockResolvedValue(undefined);

    dispatchAutomationEvent(EV);
    expect(mockEnroll).not.toHaveBeenCalled(); // setImmediate — not synchronous

    await flush();
    expect(mockEnroll).toHaveBeenCalledTimes(1);
    expect(mockEnroll).toHaveBeenCalledWith(EV);
  });

  it('swallows an enrollOnEvent rejection and logs a warning (never throws to the caller)', async () => {
    mockEnroll.mockRejectedValue(new Error('boom'));

    expect(() => dispatchAutomationEvent(EV)).not.toThrow();

    await flush();
    await flush(); // let the rejected promise's .catch microtask settle

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [message, meta] = mockWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('dispatch failed');
    expect(meta).toMatchObject({ type: EV.type, entityId: EV.entity.id, error: 'boom' });
  });
});
