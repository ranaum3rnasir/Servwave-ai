// t4 (live QA 2026-07-21/22): the Dialer's CustomerPanel history rows only
// ever read a possibly-empty stored `transcriptPreview` — there was no fetch
// path at all, so a call whose transcript wasn't ready at ingest time stayed
// permanently blank. Wire the same useCallTranscript lazy-fetch CallsView
// already uses into the row's expand interaction.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const useCallTranscript = vi.hoisted(() => vi.fn());

// These specs render deep phone components without a QueryClientProvider - every
// data hook is stubbed individually. Times now resolve against the ORG's zone, so
// the org query joins that list; pinned here so the rendered clock is fixed rather
// than the runner's.
vi.mock("@/lib/api/organization", () => ({
  useOrganization: () => ({ data: { timezone: "America/New_York" } }),
}));

vi.mock("@/lib/api/communication", () => ({
  DISPOSITION_LABELS: {},
  fmtPhone: (n: string) => n,
  useCallTranscript,
}));

vi.mock("@/lib/api/inventory", () => ({
  usePurchaseOrders: () => ({ data: [] }),
  useTechs: () => ({ data: [] }),
}));

vi.mock("@/components/communication/phone/shared", () => ({
  dayLabel: () => "day",
  shortTime: () => "time",
  DirIcon: () => null,
}));

import { CustomerPanel, type DialerSelection } from "../Dialer";
import type { CallSession } from "@/lib/api/communication";

const CALL_NO_STORED_TRANSCRIPT: CallSession = {
  id: "cc000000-0000-0000-0000-000000000001",
  direction: "inbound",
  fromNumber: "+16095551234",
  toNumber: "+12019037784",
  status: "completed",
  answeredBy: { kind: "none" },
  startedAt: new Date().toISOString(),
  customerId: "cust-1",
} as CallSession;

const SELECTION: DialerSelection = {
  customer: { id: "cust-1", name: "Pat Lee", phone: "+16095551234" },
  jobs: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  useCallTranscript.mockReturnValue({ data: undefined, isLoading: false });
});

function renderPanel(calls: CallSession[] = [CALL_NO_STORED_TRANSCRIPT]) {
  return render(
    <MemoryRouter>
      <CustomerPanel selection={SELECTION} calls={calls} onCall={vi.fn()} />
    </MemoryRouter>,
  );
}

describe("Dialer CustomerPanel — lazy transcript fetch on expand (t4)", () => {
  it("offers a View-transcript affordance even with no stored transcriptPreview", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: /view transcript/i })).toBeInTheDocument();
  });

  it("fires useCallTranscript only once the row is expanded", () => {
    renderPanel();
    // Not expanded yet — the hook must not be told to fetch.
    expect(useCallTranscript).toHaveBeenCalledWith(CALL_NO_STORED_TRANSCRIPT.id, false);

    fireEvent.click(screen.getByRole("button", { name: /view transcript/i }));

    expect(useCallTranscript).toHaveBeenCalledWith(CALL_NO_STORED_TRANSCRIPT.id, true);
  });

  it("renders the fetched transcript once expanded", () => {
    useCallTranscript.mockReturnValue({ data: { transcript: "Fetched on demand." }, isLoading: false });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /view transcript/i }));

    expect(screen.getByText(/Fetched on demand\./)).toBeInTheDocument();
  });
});
