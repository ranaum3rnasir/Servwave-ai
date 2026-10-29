// Mobile slice 24 (rubric KB-08, user story 99): the pop-out phone page's dial
// input does not focus itself on a touch device, so the keyboard does not cover
// the dialpad on load. On a desktop (fine pointer) it still opens focused, so a
// number can be typed straight away.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const placeCall = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const stashAttribution = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({}),
  isPending: false,
}));

vi.mock("@/lib/api/communication", () => ({
  BUSINESS_NUMBER: "(555) 010-0000",
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useStashCallAttribution: () => stashAttribution,
  useCallOutcome: () => ({ data: null }),
}));
vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));
vi.mock("@/lib/communication/useCtmSoftphone", () => ({
  useCtmSoftphone: () => ({
    call: vi.fn(),
    hangup: vi.fn(),
    mute: vi.fn(),
    answer: vi.fn(),
    onIncoming: vi.fn(() => () => {}),
    ready: true,
    awaitingStart: false,
  }),
}));

import { Softphone } from "../Softphone";

const originalMatchMedia = window.matchMedia;

function setPointer(pointer: "coarse" | "fine") {
  window.matchMedia = ((query: string) => ({
    matches: query.includes(`pointer: ${pointer}`),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("pop-out phone page dial input autofocus", () => {
  it("does not focus the dial input on a touch device", () => {
    setPointer("coarse");
    render(<Softphone surface="phone-tab" />);
    const dial = screen.getByPlaceholderText("Enter a number");
    expect(dial).not.toHaveFocus();
    expect(document.activeElement?.tagName).not.toBe("INPUT");
  });

  it("still focuses it on a desktop", () => {
    setPointer("fine");
    render(<Softphone surface="phone-tab" />);
    expect(screen.getByPlaceholderText("Enter a number")).toHaveFocus();
  });
});
