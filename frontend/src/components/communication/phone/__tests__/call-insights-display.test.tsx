// SERV10X-65: CTM's per-call AI summary was ingested from the wrong key, so
// the Calls "Insights" column and the drawer could only ever show "—". These
// cover the display half once the backend supplies `summary`:
//   - the drawer renders the insight, with an honest pending vs. absent state
//   - the lazy re-pull fires when the SUMMARY is missing, not just the transcript
//   - the Insights cell reflects a stored insight
//   - "Answered by" no longer calls an externally-forwarded call "No answer"
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const useCallTranscript = vi.hoisted(() => vi.fn());

// Customer numbers on the Communication screens follow the person's switches (S05.6). This suite renders the
// screen without a query client, so the person's switches are stubbed: every one on, the screen as it always was.
vi.mock("@/components/contact/useContactPolicyInput", () => ({
  useContactPolicyInput: () => ({
    switches: { copyCustomerPhone: true, copyCustomerEmail: true, contactCustomers: true, viewCustomers: true },
    phoneService: true,
  }),
}));

// These specs render deep phone components without a QueryClientProvider - every
// data hook is stubbed individually. Times now resolve against the ORG's zone, so
// the org query joins that list; pinned here so the rendered clock is fixed rather
// than the runner's.
vi.mock("@/lib/api/shared/organization", () => ({
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

import { CallDetailDrawer, InsightCell } from "../CallsView";
import { AnsweredBy } from "../shared";
import type { CallSession } from "@/lib/api/communication";
import { AbilityProvider } from "@/contexts/AbilityContext";
import { abilityWithSwitches } from "@/__tests__/support/backendSwitchCatalog";

// The insight is the call summary, which is behind View transcript (Roles & Permissions S08.12); these cases are about
// how it renders, so the person holds the switch here (call-transcript-switch.test.tsx covers the person who does not).
// View transcript needs View communication.
const mayReadTranscripts = abilityWithSwitches("View communication", "View transcript");

const BASE_CALL: CallSession = {
  id: "cd000000-0000-0000-0000-000000000003",
  direction: "inbound",
  fromNumber: "+15551230000",
  toNumber: "+12019037784",
  status: "completed",
  answeredBy: { kind: "none" },
  startedAt: new Date().toISOString(),
  durationSec: 42,
  hasRecording: false,
} as CallSession;

const SUMMARY = "Caller asked about a shower install and left a callback number.";

function renderDrawer(call: CallSession = BASE_CALL) {
  return render(
    <MemoryRouter>
      <AbilityProvider ability={mayReadTranscripts}>
        <CallDetailDrawer call={call} onClose={vi.fn()} onToast={vi.fn()} />
      </AbilityProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCallTranscript.mockReturnValue({ data: undefined, isLoading: false });
});

describe("CallDetailDrawer AI insight", () => {
  it("renders a stored summary", () => {
    renderDrawer({ ...BASE_CALL, summary: SUMMARY } as CallSession);

    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
  });

  it("renders a summary that arrives late from the lazy re-pull", () => {
    useCallTranscript.mockReturnValue({
      data: { transcript: null, summary: SUMMARY },
      isLoading: false,
    });
    renderDrawer();

    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
  });

  it("says the insight is still processing while the fetch is in flight", () => {
    useCallTranscript.mockReturnValue({ data: undefined, isLoading: true });
    renderDrawer();

    expect(screen.getByText(/still being generated/i)).toBeInTheDocument();
  });

  it("is honest once the fetch settles empty, rather than claiming it is still processing", () => {
    useCallTranscript.mockReturnValue({
      data: { transcript: null, summary: null },
      isLoading: false,
    });
    renderDrawer();

    expect(screen.getByText(/No AI insight for this call/i)).toBeInTheDocument();
    expect(screen.queryByText(/still being generated/i)).not.toBeInTheDocument();
  });

  // CTM derives the summary from the transcript, so a call can have one and
  // not the other. A stored transcript must not suppress the insight re-pull.
  it("still fires the lazy fetch when only the summary is missing", () => {
    renderDrawer({ ...BASE_CALL, transcriptPreview: "A: hi" } as CallSession);

    expect(useCallTranscript).toHaveBeenCalledWith(BASE_CALL.id, true);
  });

  it("stops fetching once both fields are present", () => {
    renderDrawer({
      ...BASE_CALL,
      transcriptPreview: "A: hi",
      summary: SUMMARY,
    } as CallSession);

    expect(useCallTranscript).toHaveBeenCalledWith(BASE_CALL.id, false);
  });
});

describe("InsightCell", () => {
  it("flags an insight when the call carries a summary", () => {
    render(<InsightCell call={{ ...BASE_CALL, summary: SUMMARY } as CallSession} />);

    expect(screen.getByText(/summary/i)).toBeInTheDocument();
  });

  it("shows the em-dash placeholder when there is no insight", () => {
    render(<InsightCell call={BASE_CALL} />);

    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("keeps the needs-review flag ahead of the summary chip", () => {
    render(
      <InsightCell
        call={{ ...BASE_CALL, summary: SUMMARY, reviewFlag: "Escalated" } as CallSession}
      />,
    );

    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });
});

describe("AnsweredBy", () => {
  // The pilot org answers on a forwarded external line: ingest maps that to
  // kind 'external', but the shared cell used to fall through to "No answer".
  it("reports a forwarded-phone answer as answered, not as No answer", () => {
    render(<AnsweredBy call={{ ...BASE_CALL, answeredBy: { kind: "external" } } as CallSession} />);

    expect(screen.getByText("Forwarded phone")).toBeInTheDocument();
    expect(screen.queryByText("No answer")).not.toBeInTheDocument();
  });

  it("still reports a genuinely unanswered call as No answer", () => {
    render(<AnsweredBy call={BASE_CALL} />);

    expect(screen.getByText("No answer")).toBeInTheDocument();
  });
});
