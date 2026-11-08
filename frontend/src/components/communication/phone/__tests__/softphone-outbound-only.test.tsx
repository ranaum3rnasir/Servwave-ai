// Outbound-only lock (2026-07-20): the browser softphone NEVER answers inbound
// calls — those ring the staff member's cell via the CTM mobile app. So even on
// the /phone tab (the only surface with a real device), the console must not
// subscribe to the device's inbound ring, and no in-browser answer card can
// appear. Inbound is still ingested into the hub + attached to the customer
// server-side; only the in-browser ring is suppressed. This test reads the REAL
// `BROWSER_INBOUND_ANSWER_ENABLED` constant (ctmSoftphone.ts is NOT mocked), so
// flipping that flag back on is what would make this test fail.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const placeCall = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const stashAttribution = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({}),
  isPending: false,
}));

// A real office device (as the /phone tab would supply): outbound methods plus
// the inbound-ring surface (onIncoming/answer) the lock must NOT touch.
type FakeDevice = {
  call: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  answer: ReturnType<typeof vi.fn>;
  onIncoming: ReturnType<typeof vi.fn>;
  ready: boolean;
  awaitingStart: boolean;
};
const softphone = vi.hoisted(() => ({ current: null as null | FakeDevice }));

vi.mock("@/lib/api/communication", () => ({
  BUSINESS_NUMBER: "(551) 282-7064",
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useStashCallAttribution: () => stashAttribution,
  useCallOutcome: () => ({ data: null }),
}));
vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));
// Only the hook is mocked — ctmSoftphone.ts (which exports the real
// BROWSER_INBOUND_ANSWER_ENABLED) is left intact on purpose.
vi.mock("@/lib/communication/useCtmSoftphone", () => ({
  useCtmSoftphone: () => softphone.current,
}));

import { Softphone } from "../Softphone";

function device(): FakeDevice {
  return {
    call: vi.fn(),
    hangup: vi.fn(),
    mute: vi.fn(),
    answer: vi.fn(),
    onIncoming: vi.fn(() => () => {}),
    ready: true, awaitingStart: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  softphone.current = null;
});

describe("Softphone outbound-only lock", () => {
  it("does not subscribe to the device inbound ring on the /phone tab", () => {
    softphone.current = device();
    render(<Softphone surface="phone-tab" />);

    // The lock: the console must never wire the device's inbound ring, so a
    // real inbound call can never surface an in-browser answer path.
    expect(softphone.current.onIncoming).not.toHaveBeenCalled();
  });

  it("shows the outbound dialer, never an inbound answer card", () => {
    softphone.current = device();
    render(<Softphone surface="phone-tab" />);

    // Outbound affordance present…
    expect(screen.getByRole("button", { name: "Call" })).toBeInTheDocument();
    // …and no Answer/Decline (those belong to the disabled inbound path).
    expect(screen.queryByRole("button", { name: /answer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /decline/i })).not.toBeInTheDocument();
  });
});
