/// <reference types="@testing-library/jest-dom/vitest" />
// Task C2 — real incoming-call UI. Task C1 wired a real onIncoming/answer()
// through the hook (useCtmSoftphone-incoming.test.ts); nothing consumed it
// yet — the ONLY answer() in the app was Softphone.tsx's local simulation
// (setState("active"), reachable only via the `incomingNumber` prop the main
// app's "Simulate incoming call" demo drives - the phone tab never passes that
// prop, so /phone never routed through it in the first place). This proves
// the /phone tab now renders IncomingCallCard.tsx off a REAL 'incoming'
// event, resolves caller identity the same way Softphone's own screen-pop
// does (matchByNumber), Answer calls the hook's REAL device answer() (not a
// local simulation) and flips to in-call controls, and Decline calls the
// REAL hangup().
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/__tests__/helpers";
import { BROWSER_INBOUND_ANSWER_ENABLED } from "@/lib/communication/ctmSoftphone";

const placeCall = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const stashAttribution = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
  isPending: false,
}));

type Channel = { id: string; kind: "phone" | "sms" | "email"; value: string };
type Contact = { id: string; name: string; role?: string; channels: Channel[] };
type Customer = { id: string; name: string; contacts: Contact[] };

const CALLER: Customer = {
  id: "cust-1",
  name: "Northwind Services",
  contacts: [
    {
      id: "contact-1",
      name: "Jamie Rivera",
      role: "Ops manager",
      channels: [{ id: "ch-1", kind: "phone", value: "+15555550199" }],
    },
  ],
};

vi.mock("@/lib/api/communication", () => ({
  BUSINESS_NUMBER: "(551) 282-7064",
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [CALLER] }),
  usePlaceCall: () => placeCall,
  useStashCallAttribution: () => stashAttribution,
  useCallOutcome: () => ({ data: null }),
  // PhoneTabPage hosts the full DialerWorkspace - these are pulled in too.
  useCalls: () => ({ data: [] }),
  useDialerSearch: () => ({ data: undefined, isFetching: false }),
  matchByNumber: (customers: Customer[], e164: string) => {
    for (const customer of customers) {
      for (const contact of customer.contacts) {
        if (contact.channels.some((c) => c.value === e164)) return { customer, contact };
      }
    }
    return null;
  },
}));

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
let incomingCb: ((info: Record<string, unknown>) => void) | null = null;

vi.mock("@/lib/communication/useCtmSoftphone", () => ({
  useCtmSoftphone: () => softphone.current,
}));

type Resolved =
  | { ctm_number_id: string; phone_number_id: string; formatted: string | null }
  | { none: true };
const myOutboundNumber = vi.hoisted(() => ({ current: null as null | Resolved }));

vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: vi.fn((enabled: boolean) => ({
    data: enabled ? myOutboundNumber.current : undefined,
  })),
}));

vi.mock("@/lib/api/phoneNumbers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/phoneNumbers")>(
    "@/lib/api/phoneNumbers",
  );
  return {
    ...actual,
    useMyNumbers: vi.fn(() => ({ data: { numbers: [] } })),
  };
});

import PhoneTabPage from "@/pages/v2/communication/PhoneTabPage";

beforeEach(() => {
  vi.clearAllMocks();
  incomingCb = null;
  softphone.current = {
    call: vi.fn(),
    hangup: vi.fn(),
    mute: vi.fn(),
    answer: vi.fn(),
    onIncoming: vi.fn((cb: (info: Record<string, unknown>) => void) => {
      incomingCb = cb;
      return () => {
        incomingCb = null;
      };
    }),
    ready: true, awaitingStart: false,
  };
  myOutboundNumber.current = {
    ctm_number_id: "TPN_1",
    phone_number_id: "pn_1",
    formatted: "(609) 555-0100",
  };
});

function ring(info: Record<string, unknown> = { from: "+15555550199", call_id: "abc123" }) {
  expect(incomingCb).not.toBeNull();
  // The mocked onIncoming callback fires a React state update outside of an
  // event handler / userEvent's own act-wrapping — wrap it explicitly so the
  // DOM is flushed before assertions run.
  act(() => {
    incomingCb!(info);
  });
}

// Outbound-only lock (2026-07-20): the browser softphone no longer answers
// inbound calls (BROWSER_INBOUND_ANSWER_ENABLED = false) — they ring the staff
// member's cell via the CTM mobile app. This whole Task C2 suite is therefore
// DORMANT: it runs only if in-app answering is flipped back on, and then guards
// the feature again. The lock itself is covered by
// components/communication/phone/__tests__/softphone-outbound-only.test.tsx.
describe.runIf(BROWSER_INBOUND_ANSWER_ENABLED)("/phone incoming-call UI (Task C2)", () => {
  it("subscribes to the hook's REAL onIncoming on mount", () => {
    renderWithProviders(<PhoneTabPage />);
    expect(softphone.current!.onIncoming).toHaveBeenCalled();
  });

  it("renders no incoming-call card until a real 'incoming' event fires", () => {
    renderWithProviders(<PhoneTabPage />);
    expect(screen.queryByText("Incoming call")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /answer/i })).not.toBeInTheDocument();
  });

  it("renders resolved caller identity on a real incoming ring", () => {
    renderWithProviders(<PhoneTabPage />);
    ring();

    expect(screen.getByText("Incoming call")).toBeInTheDocument();
    expect(screen.getByText("Northwind Services")).toBeInTheDocument();
    expect(screen.getByText(/Jamie Rivera/)).toBeInTheDocument();
  });

  it("shows 'Unknown caller' for an unmatched number", () => {
    renderWithProviders(<PhoneTabPage />);
    ring({ from: "+19294039424" });

    expect(screen.getByText("Unknown caller")).toBeInTheDocument();
  });

  it("Answer calls the hook's REAL device answer() (not a local simulation) and shows in-call controls", async () => {
    renderWithProviders(<PhoneTabPage />);
    ring();

    await userEvent.click(screen.getByRole("button", { name: /answer/i }));

    expect(softphone.current!.answer).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /answer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /decline/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hang up/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mute/i })).toBeInTheDocument();
  });

  it("Decline calls the hook's REAL hangup() and dismisses the card", async () => {
    renderWithProviders(<PhoneTabPage />);
    ring();

    await userEvent.click(screen.getByRole("button", { name: /decline/i }));

    expect(softphone.current!.hangup).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Incoming call")).not.toBeInTheDocument();
  });

  it("hanging up mid-call also calls the REAL hangup() and dismisses the card", async () => {
    renderWithProviders(<PhoneTabPage />);
    ring();
    await userEvent.click(screen.getByRole("button", { name: /answer/i }));

    await userEvent.click(screen.getByRole("button", { name: /hang up/i }));

    expect(softphone.current!.hangup).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /hang up/i })).not.toBeInTheDocument();
  });
});
