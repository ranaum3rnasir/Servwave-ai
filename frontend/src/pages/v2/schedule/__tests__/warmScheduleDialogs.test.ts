/**
 * Mobile slice 61 (PERF-03): the scheduler's dialogs are warmed after the board has settled, never
 * while its own data is still being fetched, and the warming can be cancelled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ names: [] as string[] }));

vi.mock('@/components/jobs/AssignJobDialog', () => { loads.names.push('assign'); return { AssignJobDialog: () => null }; });
vi.mock('@/components/jobs/CancelJobDialog', () => { loads.names.push('cancel'); return { CancelJobDialog: () => null }; });
vi.mock('../creation/scheduleCreatePopover', () => { loads.names.push('create'); return { ScheduleCreatePopover: () => null }; });
vi.mock('../components/eventEditor', () => { loads.names.push('editor'); return { EventEditor: () => null }; });
vi.mock('../components/eventEntryDialog', () => { loads.names.push('entry'); return { EventEntryDialog: () => null }; });
vi.mock('../components/unifiedDropModal', () => { loads.names.push('drop'); return { UnifiedDropModal: () => null }; });

import { warmScheduleDialogs } from '../scheduleDialogs';

function setReadyState(state: DocumentReadyState) {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => state });
}

describe('warmScheduleDialogs', () => {
  beforeEach(() => {
    loads.names.length = 0;
    vi.useFakeTimers();
    setReadyState('complete');
    (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = (cb: () => void) => setTimeout(cb, 0);
    (window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = (h: number) => clearTimeout(h);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    delete (document as unknown as { readyState?: unknown }).readyState;
  });

  it('importing the dialogs module downloads none of them', () => {
    expect(loads.names).toEqual([]);
  });

  it('downloads nothing until the page has been quiet for a while, then all six', async () => {
    warmScheduleDialogs();
    await vi.advanceTimersByTimeAsync(1000);
    expect(loads.names).toEqual([]);

    await vi.advanceTimersByTimeAsync(5000);
    expect([...loads.names].sort()).toEqual(['assign', 'cancel', 'create', 'drop', 'editor', 'entry']);
  });

  it('the returned function cancels the warming (the page left before it started)', async () => {
    const cancel = warmScheduleDialogs();
    cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loads.names).toEqual([]);
  });
});
