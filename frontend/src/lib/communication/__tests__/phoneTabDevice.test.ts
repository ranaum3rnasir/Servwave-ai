// The /phone tab's boot trigger switch (phoneTabDevice.ts). The default is
// asserted end-to-end in phone-tab-device-lifecycle.test.tsx; this pins the two
// settings of the switch and the sticky-activation shortcut, so flipping the
// constant after live testing is a one-line change with known behaviour.
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, renderHook } from '@testing-library/react';

import { PHONE_TAB_BOOT_TRIGGER, usePhoneTabBootGate } from '@/lib/communication/phoneTabDevice';

function setStickyActivation(value: boolean | undefined) {
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: value === undefined ? undefined : { hasBeenActive: value, isActive: false },
  });
}

afterEach(() => setStickyActivation(undefined));

describe('usePhoneTabBootGate', () => {
  it("defaults to 'mount'", () => {
    expect(PHONE_TAB_BOOT_TRIGGER).toBe('mount');
  });

  it("with the default trigger, arms on mount with no gesture", () => {
    const { result } = renderHook(() => usePhoneTabBootGate(true));
    expect(result.current).toBe(true);
  });

  it("'mount' arms immediately, with no gesture", () => {
    const { result } = renderHook(() => usePhoneTabBootGate(true, 'mount'));
    expect(result.current).toBe(true);
  });

  it("'first-gesture' stays closed until a pointerdown, then stays open", () => {
    const { result } = renderHook(() => usePhoneTabBootGate(true, 'first-gesture'));
    expect(result.current).toBe(false);

    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(result.current).toBe(true);
  });

  it("'first-gesture' also opens on a keydown or touchstart", () => {
    const key = renderHook(() => usePhoneTabBootGate(true, 'first-gesture'));
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter' });
    });
    expect(key.result.current).toBe(true);

    const touch = renderHook(() => usePhoneTabBootGate(true, 'first-gesture'));
    act(() => {
      fireEvent.touchStart(document.body);
    });
    expect(touch.result.current).toBe(true);
  });

  it("'first-gesture' arms at once when the window already has sticky user activation", () => {
    setStickyActivation(true);
    const { result } = renderHook(() => usePhoneTabBootGate(true, 'first-gesture'));
    expect(result.current).toBe(true);
  });

  it('does not listen while disabled: a gesture then does not arm it', () => {
    const { result } = renderHook(() => usePhoneTabBootGate(false, 'first-gesture'));
    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(result.current).toBe(false);
  });

  // The listeners sit on the document in the CAPTURE phase, so a control inside
  // the page that stops propagation of its own pointerdown/keydown cannot hide
  // the user's first interaction from the gate.
  it.each([
    ['pointerdown', (el: Element) => fireEvent.pointerDown(el)],
    ['keydown', (el: Element) => fireEvent.keyDown(el, { key: 'Enter' })],
  ] as const)("'first-gesture' still arms when a descendant stops propagation of %s", (type, fire) => {
    const child = document.createElement('button');
    document.body.appendChild(child);
    child.addEventListener(type, (e) => e.stopPropagation());
    try {
      const { result } = renderHook(() => usePhoneTabBootGate(true, 'first-gesture'));
      act(() => {
        fire(child);
      });
      expect(result.current).toBe(true);
    } finally {
      child.remove();
    }
  });
});
