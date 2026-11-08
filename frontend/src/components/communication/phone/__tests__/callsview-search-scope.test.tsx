// The Calls table opens scoped to the last 30 days, and the search box searches
// only inside that window. A call from six weeks ago produced
// "No calls match your search." — a FALSE ABSENCE: the call is in the system,
// just outside a range the search box never mentioned, and the reader has no
// way to tell the two apart.
//
// So: with a query, the empty state must NAME the window it searched and offer
// to widen; the widening must keep the query (widening is not a restart); and
// under an unbounded range there is nothing to disclose, so no action is
// offered. Without a query the old message is untouched.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/api/organization", () => ({
  useOrganization: () => ({ data: { timezone: "America/New_York" } }),
}));

vi.mock("@/lib/communication/phoneTabHandoff", () => ({
  requestCall: vi.fn(),
}));

const CUSTOMER_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("@/lib/api/communication", () => ({
  usePhoneCustomers: () => ({
    data: [{ id: CUSTOMER_UUID, name: "Daniel Cohen", phone: "+15551230000", contacts: [] }],
  }),
  usePhoneAgents: () => ({ data: [] }),
  useCustomerJobs: () => ({ data: [] }),
  useRecordingUrl: () => ({ data: undefined, refetch: vi.fn() }),
  useCallTranscript: () => ({ data: undefined }),
  useCallOutcome: () => ({ data: null }),
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
}));

vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

vi.mock("@/lib/api/callJob", () => ({
  useReassignCallJob: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/useIsDemoOrg", () => ({ useIsDemoOrg: () => false }));

vi.mock("@/contexts/AbilityContext", () => ({
  useAppAbility: () => ({ can: () => false }),
}));

vi.mock("@/lib/communicationAccess", () => ({
  useCanAccessCommunication: () => false,
}));

import { CallsView } from "../CallsView";
import type { CallSession } from "@/lib/api/communication";

// Six weeks before the range below — present in the system, absent from the view.
const OLD_CALL: CallSession = {
  id: "cd000000-0000-0000-0000-000000000001",
  direction: "inbound",
  fromNumber: "+15551230000",
  toNumber: "+12019037784",
  status: "completed",
  answeredBy: { kind: "none" },
  startedAt: "2026-07-01T15:00:00.000Z",
  durationSec: 42,
  customerId: CUSTOMER_UUID,
} as CallSession;

const THIRTY_DAYS = {
  start: new Date("2026-08-01T04:00:00.000Z"),
  end: new Date("2026-08-31T03:59:59.000Z"),
};
const SCOPE_LABEL = "Last 30 days (Aug 1st, 2026 – Aug 30th, 2026)";

function renderCallsView(
  props: Partial<Parameters<typeof CallsView>[0]> = {},
) {
  const onSearchAllTime = vi.fn();
  const utils = render(
    <MemoryRouter>
      <CallsView
        calls={[OLD_CALL]}
        range={THIRTY_DAYS}
        searchScope={SCOPE_LABEL}
        onSearchAllTime={onSearchAllTime}
        focus="all"
        onClearFocus={vi.fn()}
        onToast={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...utils, onSearchAllTime };
}

const searchBox = () => screen.getByPlaceholderText("Search calls…");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CallsView empty state discloses the searched date range", () => {
  it("names the range and offers to widen when a search finds nothing in it", async () => {
    renderCallsView();
    await userEvent.type(searchBox(), "Daniel");

    // Not "No calls match your search." — that sentence is what made an
    // out-of-range call look like a missing one.
    expect(
      screen.getByText(`No calls match "Daniel" in ${SCOPE_LABEL}.`),
    ).toBeInTheDocument();
    expect(screen.queryByText("No calls match your search.")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Search all time/i }),
    ).toBeInTheDocument();
  });

  it("widens on click and leaves the query intact — widening is not a restart", async () => {
    const { onSearchAllTime } = renderCallsView();
    await userEvent.type(searchBox(), "Daniel");

    await userEvent.click(screen.getByRole("button", { name: /Search all time/i }));

    expect(onSearchAllTime).toHaveBeenCalledTimes(1);
    expect(searchBox()).toHaveValue("Daniel");
  });

  it("offers no widening under an unbounded scope, and names no range", async () => {
    renderCallsView({
      range: { start: null, end: null },
      searchScope: null,
      // An all-time range shows the call, so search for something no row has.
      calls: [OLD_CALL],
    });
    await userEvent.type(searchBox(), "Zebra");

    expect(screen.getByText('No calls match "Zebra".')).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Search all time/i }),
    ).not.toBeInTheDocument();
  });

  it("leaves the no-query empty state exactly as it was", () => {
    renderCallsView();

    expect(screen.getByText("No calls match your search.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Search all time/i }),
    ).not.toBeInTheDocument();
  });
});
