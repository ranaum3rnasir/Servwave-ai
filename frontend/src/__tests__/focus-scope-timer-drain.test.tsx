import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render } from '@testing-library/react';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

// @radix-ui/react-focus-scope schedules a setTimeout(0) when a scope unmounts; that timer builds
// a CustomEvent from the global scope and dispatches it on the unmounted container. If it fires
// after the file's jsdom window was torn down, the CustomEvent class belongs to another realm and
// dispatchEvent throws "parameter 1 is not of type 'Event'" outside any test, which vitest counts
// as an unhandled error and fails the whole run (a rare CI flake under CPU load). The shared test
// setup lets those timers run while the file's window is still alive. These tests pin that: the
// unmount event must have been dispatched by the time the NEXT test starts, and by the time the
// file's last test is over.

const UNMOUNT_EVENT = 'focusScope.autoFocusOnUnmount';
const unmountEvents: string[] = [];
const timerDelays: number[] = [];
const RealCustomEvent = globalThis.CustomEvent;
const realSetTimeout = globalThis.setTimeout;

beforeAll(() => {
  globalThis.CustomEvent = class extends RealCustomEvent {
    constructor(type: string, init?: CustomEventInit) {
      super(type, init);
      if (type === UNMOUNT_EVENT) unmountEvents.push(type);
    }
  } as typeof CustomEvent;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    timerDelays.push(delay ?? 0);
    return realSetTimeout(handler, delay, ...args);
  }) as typeof setTimeout;
});

afterAll(() => {
  globalThis.CustomEvent = RealCustomEvent;
  globalThis.setTimeout = realSetTimeout;
});

describe('focus-scope unmount timers do not outlive the test that unmounted the scope', () => {
  it('a FocusScope unmount schedules a zero-delay timer (the mechanism)', () => {
    const { unmount } = render(
      <FocusScope>
        <button>inside</button>
      </FocusScope>,
    );
    const before = timerDelays.length;
    unmount();
    expect(timerDelays.slice(before)).toContain(0);
    expect(unmountEvents).toHaveLength(0);
  });

  it('the previous test’s unmount event was dispatched before this test started', () => {
    expect(unmountEvents).toHaveLength(1);
  });

  it('a scope still mounted when a test ends is also settled before the next test', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    // no unmount here: the setup's cleanup unmounts it after this test
    expect(unmountEvents).toHaveLength(1);
  });

  it('the dialog left mounted by the previous test was settled before this test started', () => {
    expect(unmountEvents).toHaveLength(2);
  });
});
