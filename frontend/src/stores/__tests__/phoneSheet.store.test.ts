// Mobile slice 63: the same-tab dialer's state. The sheet opens pre-filled with the number and the
// record it was tapped from; a call in progress collapses it to a call bar (never closes it, never
// drops the call); a finished or never-placed call closes it.
import { beforeEach, describe, expect, it } from 'vitest';

import { isCallInProgress, usePhoneSheetStore } from '../phoneSheet.store';

const CONTEXT = { customerId: 'c-1', customerName: 'Dana Reyes' };

beforeEach(() => usePhoneSheetStore.getState().reset());

describe('phoneSheet.store', () => {
  it('starts closed, with nothing pending', () => {
    const s = usePhoneSheetStore.getState();
    expect(s.mode).toBe('closed');
    expect(s.prefillNumber).toBeNull();
    expect(s.call.phase).toBe('idle');
  });

  it('open() shows the sheet pre-filled with the number and the record', () => {
    usePhoneSheetStore.getState().open('5551234567', CONTEXT);
    const s = usePhoneSheetStore.getState();
    expect(s.mode).toBe('sheet');
    expect(s.prefillNumber).toBe('5551234567');
    expect(s.context).toEqual(CONTEXT);
  });

  it('open() with no number is the bare dialer (the top bar button)', () => {
    usePhoneSheetStore.getState().open();
    const s = usePhoneSheetStore.getState();
    expect(s.mode).toBe('sheet');
    expect(s.prefillNumber).toBeNull();
    expect(s.context).toBeNull();
  });

  it('the pre-fill is consumed once; the record stays for the call it will attribute', () => {
    usePhoneSheetStore.getState().open('5551234567', CONTEXT);
    usePhoneSheetStore.getState().consumePrefill();
    const s = usePhoneSheetStore.getState();
    expect(s.prefillNumber).toBeNull();
    expect(s.context).toEqual(CONTEXT);
  });

  it('collapse() with no call in progress closes the sheet', () => {
    usePhoneSheetStore.getState().open('5551234567');
    usePhoneSheetStore.getState().collapse();
    expect(usePhoneSheetStore.getState().mode).toBe('closed');
  });

  it.each(['calling', 'placed', 'active', 'ringing'] as const)(
    'collapse() with a call %s keeps it alive as the call bar',
    (phase) => {
      const store = usePhoneSheetStore.getState();
      store.open('5551234567');
      store.reportCall({ phase, number: '+15551234567' });
      store.collapse();
      expect(usePhoneSheetStore.getState().mode).toBe('bar');
      expect(isCallInProgress(usePhoneSheetStore.getState().call)).toBe(true);
    },
  );

  it('a call that has ended is not "in progress": collapse() closes', () => {
    const store = usePhoneSheetStore.getState();
    store.open('5551234567');
    store.reportCall({ phase: 'ended', number: '+15551234567' });
    expect(isCallInProgress(usePhoneSheetStore.getState().call)).toBe(false);
    store.collapse();
    expect(usePhoneSheetStore.getState().mode).toBe('closed');
  });

  it('expand() brings the bar back up as the sheet', () => {
    const store = usePhoneSheetStore.getState();
    store.open('5551234567');
    store.reportCall({ phase: 'placed', number: '+15551234567' });
    store.collapse();
    store.expand();
    expect(usePhoneSheetStore.getState().mode).toBe('sheet');
  });

  it('open() while a call is in progress shows the call and never swaps its number or record', () => {
    const store = usePhoneSheetStore.getState();
    store.open('5551234567', CONTEXT);
    store.consumePrefill();
    store.reportCall({ phase: 'placed', number: '+15551234567' });
    store.collapse();

    store.open('5559998888', { customerId: 'c-2' });

    const s = usePhoneSheetStore.getState();
    expect(s.mode).toBe('sheet');
    expect(s.prefillNumber).toBeNull();
    expect(s.context).toEqual(CONTEXT);
  });

  it('close() resets the call as well as the sheet', () => {
    const store = usePhoneSheetStore.getState();
    store.open('5551234567', CONTEXT);
    store.reportCall({ phase: 'ended', number: '+15551234567' });
    store.close();
    const s = usePhoneSheetStore.getState();
    expect(s.mode).toBe('closed');
    expect(s.call.phase).toBe('idle');
    expect(s.context).toBeNull();
  });
});
