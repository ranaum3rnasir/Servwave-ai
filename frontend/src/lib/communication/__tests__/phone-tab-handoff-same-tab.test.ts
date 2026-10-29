// Mobile slice 63: on a phone and in the installed app a Call never opens a window or tab (a Home
// Screen app and an in-app browser drop a new window, and a phone suspends a background tab). It
// opens the dialer in the SAME tab, as a sheet pre-filled with the number and the record. The
// device is emulated through the browser inputs the real check reads, not by mocking the check.
// A computer keeps the dedicated phone tab (phone-tab-handoff.test.ts covers that path in full).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DESKTOP,
  PHONE_INSTALLED,
  PHONE_PORTRAIT,
  TABLET_INSTALLED,
  emulateDevice,
} from '@/__tests__/support/deviceShape';

const JOB_CONTEXT = {
  jobId: 'b0000000-0000-0000-0000-000000000001',
  jobLabel: 'J00042',
  customerId: 'c0000000-0000-0000-0000-000000000001',
  customerName: 'Daniel Cohen',
};

describe('requestCall / openPhoneTab by device', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let restoreDevice: (() => void) | null = null;

  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  });
  afterEach(() => {
    restoreDevice?.();
    restoreDevice = null;
    vi.restoreAllMocks();
  });

  it.each([
    ['a phone', PHONE_PORTRAIT],
    ['the installed app on a phone', PHONE_INSTALLED],
    ['the installed app on a full-size tablet', TABLET_INSTALLED],
  ])('Call from %s opens the sheet pre-filled with the number and record, and opens no window', async (_n, shape) => {
    restoreDevice = emulateDevice(shape);
    const { requestCall } = await import('../phoneTabHandoff');
    const { usePhoneSheetStore } = await import('@/stores/phoneSheet.store');

    requestCall('+16098745252', JOB_CONTEXT);

    expect(openSpy).not.toHaveBeenCalled();
    const s = usePhoneSheetStore.getState();
    expect(s.mode).toBe('sheet');
    expect(s.prefillNumber).toBe('+16098745252');
    expect(s.context).toEqual(JOB_CONTEXT);
  });

  it('the header dialer button opens the same sheet with no number, and no window', async () => {
    restoreDevice = emulateDevice(PHONE_PORTRAIT);
    const { openPhoneTab } = await import('../phoneTabHandoff');
    const { usePhoneSheetStore } = await import('@/stores/phoneSheet.store');

    openPhoneTab();

    expect(openSpy).not.toHaveBeenCalled();
    expect(usePhoneSheetStore.getState().mode).toBe('sheet');
    expect(usePhoneSheetStore.getState().prefillNumber).toBeNull();
  });

  it('a computer still opens the dedicated phone tab, and the sheet stays shut', async () => {
    restoreDevice = emulateDevice(DESKTOP);
    const { requestCall } = await import('../phoneTabHandoff');
    const { usePhoneSheetStore } = await import('@/stores/phoneSheet.store');

    requestCall('+16098745252', JOB_CONTEXT);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0]![1]).toBe('servwave-phone');
    expect(usePhoneSheetStore.getState().mode).toBe('closed');
  });
});
