// Dialer auto-pick (unify-dialer, Task #56) — when a call is placed from a Job
// or Customer elsewhere in the app, it lands on the `/phone` tab as an
// `openNumber` + `openContext` handoff. The workspace must not just prefill the
// softphone; it must ALSO drive the right panel, so the caller sees WHO they're
// calling and WHAT it's about the moment the tab focuses — with zero typing.
//
// Precedence proved here: the job from context → the customer from context →
// the resolved phone identity → a sole customer match.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { DialerEntityContext } from "@/stores/dialer.store";

const mockNavigate = vi.fn();
// These specs render deep phone components without a QueryClientProvider - every
// data hook is stubbed individually. Times now resolve against the ORG's zone, so
// the org query joins that list; pinned here so the rendered clock is fixed rather
// than the runner's.
vi.mock("@/lib/api/organization", () => ({
  useOrganization: () => ({ data: { timezone: "America/New_York" } }),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// Stable place-call spy so a spec can assert the POSTed attribution body.
const placeCall = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));

const CUSTOMER_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_77_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_88_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const seam = vi.hoisted(() => ({ result: null as unknown }));

vi.mock("@/lib/api/communication", () => ({
  BUSINESS_NUMBER: "(551) 282-7064",
  DISPOSITION_LABELS: {},
  fmtPhone: (n: string) => n,
  useCalls: () => ({ data: [] }),
  useMessageThreads: () => ({ data: [] }),
  usePhoneAgents: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useStashCallAttribution: () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useCallOutcome: () => ({ data: null }),
  usePhoneCustomers: () => ({ data: [] }),
  // The workspace searches by the dialed number; the mock returns the same
  // canned result regardless of the query string (the debounced query is the
  // dialed E.164, which the auto-pick effect matches on).
  useDialerSearch: () => ({ data: seam.result, isFetching: false }),
}));

vi.mock("@/lib/api/inventory", () => ({
  usePurchaseOrders: () => ({ data: [] }),
  useTechs: () => ({ data: [] }),
}));

vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

vi.mock("@/components/communication/phone/shared", () => ({
  dayLabel: () => "day",
  shortTime: () => "time",
  DirIcon: () => null,
}));

import { DialerWorkspace } from "../Dialer";

const MATCH_RESULT = {
  query: { isPhone: true, e164: "+15555550199" },
  customers: [
    {
      id: CUSTOMER_UUID,
      name: "ZZ-TEST CTM",
      phone: "5555550199",
      site: "1 Main St, Newark",
      openJobs: [
        { id: JOB_77_UUID, number: "J00077", status: "SCHEDULED", location: "1 Main St, Newark" },
        { id: JOB_88_UUID, number: "J00088", status: "IN_PROGRESS", location: "2 Oak Ave, Jersey City" },
      ],
    },
  ],
  jobs: [
    {
      id: JOB_88_UUID,
      number: "J00088",
      status: "IN_PROGRESS",
      location: "2 Oak Ave, Jersey City",
      customer: { id: CUSTOMER_UUID, name: "ZZ-TEST CTM", phone: "5555550199" },
    },
  ],
  identity: {
    kind: "customer",
    id: CUSTOMER_UUID,
    label: "ZZ-TEST CTM",
    customerId: CUSTOMER_UUID,
    leadId: null,
    vendorId: null,
  },
};

function renderWorkspace(openContext: DialerEntityContext | null) {
  render(
    <MemoryRouter>
      <DialerWorkspace
        calls={[]}
        onToast={() => {}}
        openNumber="+15555550199"
        openContext={openContext}
        openNonce={1}
      />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  seam.result = MATCH_RESULT;
});

describe("Dialer auto-pick on entity-context handoff (Task #56)", () => {
  it("auto-shows the customer panel from a customerId handoff — no typing", async () => {
    renderWorkspace({ customerId: CUSTOMER_UUID, customerName: "ZZ-TEST CTM" });

    // The right panel resolves on its own: customer header + both open-job chips.
    expect(await screen.findByText("ZZ-TEST CTM")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /J00077/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /J00088/ })).toBeInTheDocument();
    // The softphone is prefilled with the DIALED number (kept verbatim, not
    // replaced by the customer's stored number) so the call is one click away.
    expect(screen.getByPlaceholderText("Enter a number")).toHaveValue("+15555550199");
  });

  it("focuses the job from context first when the handoff carries a jobId", async () => {
    renderWorkspace({
      jobId: JOB_88_UUID,
      jobLabel: "J00088",
      customerId: CUSTOMER_UUID,
      customerName: "ZZ-TEST CTM",
    });

    expect(await screen.findByText("ZZ-TEST CTM")).toBeInTheDocument();
    const chips = screen.getAllByRole("button", { name: /J000\d\d/ });
    // Picked job is first + carries the focused treatment.
    expect(chips[0]!.textContent).toContain("J00088");
    expect(chips[0]!.className).toContain("bg-primary/10");
    // Its location renders under the chips (focused-job detail).
    expect(screen.getByText("2 Oak Ave, Jersey City")).toBeInTheDocument();

    // Critical: placing the call preserves the FULL handoff attribution — the
    // auto-pick must NOT have clobbered job_id with a customer-only context.
    await userEvent.click(screen.getByRole("button", { name: "Call" }));
    await vi.waitFor(() => expect(placeCall.mutate).toHaveBeenCalledTimes(1));
    const body = placeCall.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.job_id).toBe(JOB_88_UUID);
    expect(body.customer_id).toBe(CUSTOMER_UUID);
    expect(body.to_number).toBe("+15555550199");
  });

  it("falls back to the resolved phone identity when no context rides along", async () => {
    renderWorkspace(null);

    // Bare number dial (header handoff / unknown Call): the identity resolves
    // the customer, and the panel still auto-shows them.
    expect(await screen.findByText("ZZ-TEST CTM")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /J00077/ })).toBeInTheDocument();
    // The dropdown is NOT left open — auto-pick is silent.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Recognized/ })).not.toBeInTheDocument(),
    );
  });
});
