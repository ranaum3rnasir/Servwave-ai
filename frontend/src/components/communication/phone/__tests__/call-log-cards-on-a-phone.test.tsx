/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 71 (rubric CMP-01, call log): below md the 1,540 px call log renders as one card per
// call, and from md up it is the table it always was. ONE tree is mounted, never both.
//
// The phone is emulated through the browser input the app's media-query hook reads (`matchMedia`),
// not by mocking the hook, so a regression to a different breakpoint would be seen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const requestCall = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/organization", () => ({
  useOrganization: () => ({ data: { timezone: "America/New_York" } }),
}));
vi.mock("@/lib/communication/phoneTabHandoff", () => ({ requestCall }));

const CUSTOMER_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.mock("@/lib/api/communication", async (importOriginal) => ({
  // The real module for the constants the detail drawer reads; every data hook is stubbed below.
  ...(await importOriginal<typeof import("@/lib/api/communication")>()),
  usePhoneCustomers: () => ({
    data: [{ id: CUSTOMER_UUID, name: "Daniel Cohen", phone: "+15551230000", contacts: [] }],
  }),
  usePhoneAgents: () => ({ data: [] }),
  useCustomerJobs: () => ({ data: [] }),
  useRecordingUrl: () => ({ data: undefined, refetch: vi.fn() }),
  useCallTranscript: () => ({ data: undefined }),
  DISPOSITION_LABELS: {},
  fmtPhone: (n: string) => n,
  BUSINESS_NUMBER: "(551) 282-7064",
  useCalls: () => ({ data: [] }),
  useMessageThreads: () => ({ data: [] }),
  useDialerSearch: () => ({ data: null, isFetching: false }),
  useSendSms: () => ({ mutate: vi.fn(), isPending: false }),
  usePlaceCall: () => ({ mutate: vi.fn(), isPending: false }),
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  }),
  useCallOutcome: () => ({ data: null }),
}));
// The detail panel's attach-to-job search is its own concern; only that it opens is asserted here.
vi.mock("@/components/communication/shared/useAttachTargets", () => ({
  useAttachTargets: () => ({ search: "", setSearch: vi.fn(), querying: false, jobs: [], leads: [], isLoading: false }),
}));
vi.mock("@/lib/api/myOutboundNumber", () => ({ useMyOutboundNumber: () => ({ data: undefined }) }));
vi.mock("@/lib/api/callJob", () => ({
  useReassignCallJob: () => ({ mutate: vi.fn(), isPending: false }),
  useReassignCallLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/useIsDemoOrg", () => ({ useIsDemoOrg: () => false }));
vi.mock("@/contexts/AbilityContext", () => ({ useAppAbility: () => ({ can: () => false }) }));
vi.mock("@/lib/communicationAccess", () => ({ useCanAccessCommunication: () => false }));

import { CallsView } from "../CallsView";
import type { CallSession } from "@/lib/api/communication";
import { DESKTOP, PHONE_PORTRAIT, emulateDevice } from "@/__tests__/support/deviceShape";

const MISSED: CallSession = {
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
  tags: ["Water heater"],
} as CallSession;

const ANSWERED: CallSession = {
  id: "cd000000-0000-0000-0000-000000000002",
  direction: "outbound",
  fromNumber: "+12019037784",
  toNumber: "+15559990000",
  status: "completed",
  answeredBy: { kind: "csr", name: "Dana" },
  startedAt: new Date().toISOString(),
  durationSec: 95,
  trackingSource: "Google Ads",
} as CallSession;

let restoreDevice: (() => void) | null = null;

function renderLog() {
  return render(
    <MemoryRouter>
      <CallsView
        calls={[MISSED, ANSWERED]}
        range={{ start: null, end: null }}
        focus="all"
        onClearFocus={vi.fn()}
        onToast={vi.fn()}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  restoreDevice?.();
  restoreDevice = null;
});

describe("the call log on a phone (below md)", () => {
  beforeEach(() => {
    restoreDevice = emulateDevice({ ...PHONE_PORTRAIT, viewportWidth: 390 });
  });

  it("is one card per call, named by who called, and no table", () => {
    renderLog();
    const list = screen.getByRole("list", { name: "Calls" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByRole("button", { name: /Daniel Cohen/ })).toBeInTheDocument();
    // A caller with no customer record is named by their number, not "Unknown".
    expect(within(list).getByRole("button", { name: "+15559990000" })).toBeInTheDocument();
    expect(document.querySelector("table, [role=table], [role=grid]")).toBeNull();
  });

  it("reads each call in words: direction, outcome, number, time, who answered", () => {
    renderLog();
    const [missed, answered] = within(screen.getByRole("list", { name: "Calls" })).getAllByRole("listitem");
    expect(missed).toHaveTextContent(/Inbound/);
    expect(missed).toHaveTextContent(/Missed/);
    expect(missed).toHaveTextContent("+15551230000");
    expect(missed).toHaveTextContent("J00042");
    expect(missed).toHaveTextContent("Water heater");
    expect(answered).toHaveTextContent(/Outbound/);
    expect(answered).toHaveTextContent(/Completed/);
    expect(answered).toHaveTextContent("Google Ads");
    expect(answered).toHaveTextContent("1 Min 35 Sec");
  });

  it("keeps Call Back, with the same hand-off and context as the table's button", async () => {
    renderLog();
    const [missed] = within(screen.getByRole("list", { name: "Calls" })).getAllByRole("listitem");
    await userEvent.click(within(missed!).getByRole("button", { name: /Call Back/i }));
    expect(requestCall).toHaveBeenCalledTimes(1);
    expect(requestCall).toHaveBeenCalledWith("+15551230000", {
      customerId: CUSTOMER_UUID,
      customerName: "Daniel Cohen",
      jobId: JOB_UUID,
      jobLabel: "J00042",
    });
  });

  it("offers Dismiss only on a call that can be recovered, and it hides the card", async () => {
    renderLog();
    const list = screen.getByRole("list", { name: "Calls" });
    const [missed, answered] = within(list).getAllByRole("listitem");
    expect(within(answered!).queryByRole("button", { name: /Dismiss/i })).toBeNull();
    await userEvent.click(within(missed!).getByRole("button", { name: /Dismiss/i }));
    expect(within(screen.getByRole("list", { name: "Calls" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("opens the call's detail when a card is tapped", async () => {
    renderLog();
    await userEvent.click(screen.getByRole("button", { name: /Daniel Cohen/ }));
    expect(await screen.findByText(/Call details for Daniel Cohen/)).toBeInTheDocument();
  });

  it("still says so when nothing matches", async () => {
    render(
      <MemoryRouter>
        <CallsView calls={[]} range={{ start: null, end: null }} focus="all" onClearFocus={vi.fn()} onToast={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("No calls match your search.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Calls" })).toBeNull();
  });
});

describe("the call log from md up", () => {
  it("stays the table: no cards", () => {
    restoreDevice = emulateDevice({ ...DESKTOP, viewportWidth: 1280 });
    renderLog();
    expect(screen.queryByRole("list", { name: "Calls" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: /Status/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Call Back/i })).toHaveLength(2);
  });
});
