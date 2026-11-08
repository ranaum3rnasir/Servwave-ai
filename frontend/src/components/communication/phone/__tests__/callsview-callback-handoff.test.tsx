// o4f (live QA 2026-07-21): the call-log "Call Back" opened an in-page popup
// (ActiveCallPopup) that fell onto the click-to-call BRIDGE path — which
// originated the call on the org's own tracking number and dropped the caller
// into that number's call flow instead of a two-way call. Call Back must use
// the SAME /phone-tab handoff (requestCall) as every entity surface, carrying
// the row's customer/job context, and never mount an in-page dialer popup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const requestCall = vi.hoisted(() => vi.fn());
// These specs render deep phone components without a QueryClientProvider - every
// data hook is stubbed individually. Times now resolve against the ORG's zone, so
// the org query joins that list; pinned here so the rendered clock is fixed rather
// than the runner's.
vi.mock("@/lib/api/organization", () => ({
  useOrganization: () => ({ data: { timezone: "America/New_York" } }),
}));

vi.mock("@/lib/communication/phoneTabHandoff", () => ({
  requestCall,
}));

const CUSTOMER_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.mock("@/lib/api/communication", () => ({
  usePhoneCustomers: () => ({
    data: [{ id: CUSTOMER_UUID, name: "Daniel Cohen", phone: "+15551230000", contacts: [] }],
  }),
  usePhoneAgents: () => ({ data: [] }),
  useCustomerJobs: () => ({ data: [] }),
  useRecordingUrl: () => ({ data: undefined, refetch: vi.fn() }),
  useCallTranscript: () => ({ data: undefined }),
  DISPOSITION_LABELS: {},
  fmtPhone: (n: string) => n,
  // Pulled in transitively by the Dialer module (ActiveCallPopup/MessagePanel
  // live there) — CallsView itself must never place a call after this fix.
  BUSINESS_NUMBER: "(551) 282-7064",
  useCalls: () => ({ data: [] }),
  useMessageThreads: () => ({ data: [] }),
  useDialerSearch: () => ({ data: null, isFetching: false }),
  useSendSms: () => ({ mutate: vi.fn(), isPending: false }),
  usePlaceCall: () => ({ mutate: vi.fn(), isPending: false }),
  useStashCallAttribution: () => ({
  useCallOutcome: () => ({ data: null }),
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  }),
}));

vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

vi.mock("@/lib/api/callJob", () => ({
  useReassignCallJob: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/useIsDemoOrg", () => ({
  useIsDemoOrg: () => false,
}));

vi.mock("@/contexts/AbilityContext", () => ({
  useAppAbility: () => ({ can: () => false }),
}));

vi.mock("@/lib/communicationAccess", () => ({
  useCanAccessCommunication: () => false,
}));

import { CallsView } from "../CallsView";
import type { CallSession } from "@/lib/api/communication";

const MISSED_CALL: CallSession = {
  id: "cd000000-0000-0000-0000-000000000001",
  direction: "inbound",
  fromNumber: "+15551230000",
  toNumber: "+12019037784",
  status: "missed",
  answeredBy: { kind: "none" },
  startedAt: new Date().toISOString(),
  durationSec: 0,
  customerId: CUSTOMER_UUID,
  jobId: JOB_UUID,
  jobLabel: "J00042",
} as CallSession;

function renderCallsView() {
  return render(
    <MemoryRouter>
      <CallsView
        calls={[MISSED_CALL]}
        range={{ start: null, end: null }}
        focus="callback"
        onClearFocus={vi.fn()}
        onToast={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CallsView row Call Back → /phone tab handoff (o4f)", () => {
  it("routes through requestCall with the counterpart number + customer/job context", async () => {
    renderCallsView();

    await userEvent.click(await screen.findByRole("button", { name: /Call Back/i }));

    expect(requestCall).toHaveBeenCalledTimes(1);
    expect(requestCall).toHaveBeenCalledWith("+15551230000", {
      customerId: CUSTOMER_UUID,
      customerName: "Daniel Cohen",
      jobId: JOB_UUID,
      jobLabel: "J00042",
    });
  });

  it("never mounts an in-page dialer popup", async () => {
    renderCallsView();

    await userEvent.click(await screen.findByRole("button", { name: /Call Back/i }));

    // The old ActiveCallPopup embedded a Softphone (dial input + Call button).
    expect(screen.queryByPlaceholderText("Enter a number")).not.toBeInTheDocument();
  });
});
