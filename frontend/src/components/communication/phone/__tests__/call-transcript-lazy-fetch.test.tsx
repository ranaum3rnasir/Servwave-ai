// t4 (live QA 2026-07-21/22): CTM transcribes asynchronously AFTER the `end`
// webhook, so most calls have no `transcriptPreview` at ingest. The call-log
// drawer used to gate the transcript fetch/section on `hasRecording`, but the
// backend endpoint only needs `ctm_call_id` — a call with no recording (or
// one whose recording hasn't landed yet) can still have a transcript.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
  usePhoneCustomers: () => ({ data: [] }),
  usePhoneAgents: () => ({ data: [] }),
  useCustomerJobs: () => ({ data: [] }),
  useCustomerLeads: () => ({ data: [] }),
  useJobSearch: () => ({ data: [] }),
  useLeadSearch: () => ({ data: [] }),
  ATTACH_SEARCH_MIN: 2,
  useRecordingUrl: () => ({ data: undefined, refetch: vi.fn() }),
  useCallTranscript,
  DISPOSITION_LABELS: {},
  fmtPhone: (n: string) => n,
}));

vi.mock("@/lib/api/callJob", () => ({
  useReassignCallJob: () => ({ mutate: vi.fn(), isPending: false }),
  useReassignCallLead: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/useIsDemoOrg", () => ({
  useIsDemoOrg: () => false,
}));

vi.mock("@/lib/communication/phoneTabHandoff", () => ({
  requestCall: vi.fn(),
}));

import { CallDetailDrawer } from "../CallsView";
import type { CallSession } from "@/lib/api/communication";

const NO_RECORDING_CALL: CallSession = {
  id: "cd000000-0000-0000-0000-000000000002",
  direction: "inbound",
  fromNumber: "+15551230000",
  toNumber: "+12019037784",
  status: "completed",
  answeredBy: { kind: "none" },
  startedAt: new Date().toISOString(),
  durationSec: 42,
  hasRecording: false,
} as CallSession;

function renderDrawer(call: CallSession = NO_RECORDING_CALL) {
  return render(
    <MemoryRouter>
      <CallDetailDrawer call={call} onClose={vi.fn()} onToast={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCallTranscript.mockReturnValue({ data: undefined, isLoading: false });
});

describe("CallDetailDrawer transcript section (t4)", () => {
  it("fetches the transcript even when the call has no recording", () => {
    renderDrawer();

    expect(useCallTranscript).toHaveBeenCalledWith(NO_RECORDING_CALL.id, true);
  });

  it("shows the transcript section (with fetched content) for a hasRecording=false call", () => {
    useCallTranscript.mockReturnValue({ data: { transcript: "Hi, this is a test call." }, isLoading: false });
    renderDrawer();

    expect(screen.getByText(/Transcript/)).toBeInTheDocument();
    expect(screen.getByText(/Hi, this is a test call\./)).toBeInTheDocument();
    // The recording player never mounts — no recording exists.
    expect(screen.getByText("No recording for this call")).toBeInTheDocument();
  });

  it("keeps the existing stored-transcript path working (no regression)", () => {
    renderDrawer({ ...NO_RECORDING_CALL, transcriptPreview: "Already stored." } as CallSession);

    expect(screen.getByText(/Already stored\./)).toBeInTheDocument();
  });
});

describe("CallDetailDrawer transcript peek + reader (SERV10X-65 PR3)", () => {
  const TURNS = [
    { speaker: "PRINCETON NJ", text: "Can you hear me?", channel: 1, startSec: 0.5, endSec: 2.1 },
    { speaker: "Art Nakamura", text: "Yes, go ahead.", channel: 2, startSec: 2.4, endSec: 3.9 },
    { speaker: "PRINCETON NJ", text: "Great, I had a question.", channel: 1, startSec: 4, endSec: 5.5 },
    { speaker: "Art Nakamura", text: "Sure, go for it.", channel: 2, startSec: 5.6, endSec: 6.2 },
  ];

  it("shows a bubble peek (capped at 3 turns) and an Open transcript trigger when turns are present", () => {
    useCallTranscript.mockReturnValue({ data: { transcript: null, summary: null, turns: TURNS }, isLoading: false });
    renderDrawer();

    expect(screen.getByText("Can you hear me?")).toBeInTheDocument();
    expect(screen.getByText("Yes, go ahead.")).toBeInTheDocument();
    expect(screen.getByText("Great, I had a question.")).toBeInTheDocument();
    // Fourth turn is beyond the 3-turn peek cap.
    expect(screen.queryByText("Sure, go for it.")).not.toBeInTheDocument();
    expect(screen.getByText(/Open transcript \(4 turns\)/)).toBeInTheDocument();
  });

  it("opens the full reader with every turn when Open transcript is clicked", () => {
    useCallTranscript.mockReturnValue({ data: { transcript: null, summary: null, turns: TURNS }, isLoading: false });
    renderDrawer();

    fireEvent.click(screen.getByText(/Open transcript \(4 turns\)/));

    expect(screen.getByRole("dialog", { name: "Transcript" })).toBeInTheDocument();
    // The fourth turn, hidden in the peek, is visible once the reader opens.
    expect(screen.getByText("Sure, go for it.")).toBeInTheDocument();
  });

  it("falls back to the flat transcript string when no turns are available", () => {
    useCallTranscript.mockReturnValue({
      data: { transcript: "A: hi\nB: hello", summary: null, turns: null },
      isLoading: false,
    });
    renderDrawer();

    expect(screen.getByText(/A: hi/)).toBeInTheDocument();
    expect(screen.getByText("Open transcript")).toBeInTheDocument();
  });
});
