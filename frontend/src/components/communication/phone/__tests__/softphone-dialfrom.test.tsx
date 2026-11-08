// Master plan Task B2 — the softphone dials from the user's RESOLVED
// caller-ID number. The office WebRTC softphone path (`/phone` tab) fetches
// Task B1's resolved number (GET /api/communication/my-outbound-number, via
// useMyOutboundNumber) and passes its ctm_number_id into
// officeSoftphone.call(e164, fromTpnId) — the OfficeSoftphone handle already
// threads fromTpnId through dialFrom() before dialing
// (useCtmSoftphone.ts:113-116); this task only has to fetch the number and
// pass it in. The bridge/tel path (officeSoftphone null) never fetches this —
// its from-number is resolved server-side.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const placeCall = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const stashAttribution = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
  isPending: false,
}));

vi.mock("@/lib/api/communication", () => ({
  BUSINESS_NUMBER: "(551) 282-7064",
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useStashCallAttribution: () => stashAttribution,
  useCallOutcome: () => ({ data: null }),
}));

type FakeDevice = {
  call: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  ready: boolean;
  awaitingStart: boolean;
};
// null by default (bridge/tel path) — a test sets it to a fake office
// softphone handle to exercise the office-softphone path.
const softphone = vi.hoisted(() => ({ current: null as null | FakeDevice }));

vi.mock("@/lib/communication/useCtmSoftphone", () => ({
  useCtmSoftphone: () => softphone.current,
}));

// The resolved caller-ID (Task B1) — a test sets `.current` before
// rendering. `null` mimics "still loading" (no `.data` yet).
type Resolved =
  | { provider_number_id?: string; ctm_number_id?: string; phone_number_id: string; formatted: string | null }
  | { none: true };
const myOutboundNumber = vi.hoisted(() => ({ current: null as null | Resolved }));

vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: vi.fn((enabled: boolean) => ({
    data: enabled ? myOutboundNumber.current : undefined,
  })),
}));

import { Softphone } from "../Softphone";
import { useMyOutboundNumber } from "@/lib/api/myOutboundNumber";

beforeEach(() => {
  vi.clearAllMocks();
  softphone.current = null;
  myOutboundNumber.current = null;
});

describe("Softphone dials from the resolved caller-ID number (Task B2)", () => {
  it("passes the resolved ctm_number_id into officeSoftphone.call as fromTpnId", async () => {
    softphone.current = { call: vi.fn(), hangup: vi.fn(), mute: vi.fn(), ready: true, awaitingStart: false };
    myOutboundNumber.current = {
      ctm_number_id: "TPN123",
      phone_number_id: "pn_1",
      formatted: "(609) 555-0100",
    };

    render(<Softphone prefillNumber="5555550199" surface="phone-tab" />);
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199", "TPN123"),
    );
  });

  // The backend names the id `provider_number_id`; the old `ctm_number_id`
  // still arrives for one release. The frontend and backend deploy minutes
  // apart in no fixed order, so the new bundle must work against either shape.
  it("dials from provider_number_id when the response carries only the neutral key", async () => {
    softphone.current = { call: vi.fn(), hangup: vi.fn(), mute: vi.fn(), ready: true, awaitingStart: false };
    myOutboundNumber.current = { provider_number_id: "TPN_NEW", phone_number_id: "pn_1", formatted: null };

    render(<Softphone prefillNumber="5555550199" surface="phone-tab" />);
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199", "TPN_NEW"),
    );
  });

  it("still dials from ctm_number_id against an old backend that sends no neutral key", async () => {
    softphone.current = { call: vi.fn(), hangup: vi.fn(), mute: vi.fn(), ready: true, awaitingStart: false };
    myOutboundNumber.current = { ctm_number_id: "TPN_OLD", phone_number_id: "pn_1", formatted: null };

    render(<Softphone prefillNumber="5555550199" surface="phone-tab" />);
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199", "TPN_OLD"),
    );
  });

  it("fetches the resolved number (enabled=true) only when the office-softphone device is present", () => {
    softphone.current = { call: vi.fn(), hangup: vi.fn(), mute: vi.fn(), ready: true, awaitingStart: false };
    render(<Softphone surface="phone-tab" />);
    expect(useMyOutboundNumber).toHaveBeenCalledWith(true);
  });

  it("does not fetch (enabled=false) on the bridge/tel path (officeSoftphone null)", () => {
    render(<Softphone />);
    expect(useMyOutboundNumber).toHaveBeenCalledWith(false);
  });

  it("falls back to no fromTpnId when the resolver returns {none:true} (org has no number)", async () => {
    softphone.current = { call: vi.fn(), hangup: vi.fn(), mute: vi.fn(), ready: true, awaitingStart: false };
    myOutboundNumber.current = { none: true };

    render(<Softphone prefillNumber="5555550199" surface="phone-tab" />);
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() => expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199"));
    expect(softphone.current!.call).not.toHaveBeenCalledWith(
      "+15555550199",
      expect.anything(),
    );
  });

  it("falls back to no fromTpnId while the resolver is still loading (no data yet)", async () => {
    softphone.current = { call: vi.fn(), hangup: vi.fn(), mute: vi.fn(), ready: true, awaitingStart: false };
    myOutboundNumber.current = null; // still loading

    render(<Softphone prefillNumber="5555550199" surface="phone-tab" />);
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() => expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199"));
  });
});
