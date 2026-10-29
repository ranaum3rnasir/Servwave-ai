// Issue #356 — the dialer search dropdown must reliably close when a
// result is selected, on Escape, and on outside click; it opens on typing.
// The dropdown now renders REAL dialer-search results (the canonical
// GET /api/communication/dialer-search endpoint), mocked here at the seam.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

const ACME_RESULT = {
  query: { isPhone: false, e164: null },
  customers: [
    {
      id: CUSTOMER_ID,
      name: "Acme Plumbing",
      phone: "2125551000",
      site: "123 Main St",
      openJobs: [
        { id: JOB_ID, number: "J00100", status: "SCHEDULED", location: "123 Main St" },
      ],
    },
  ],
  jobs: [
    {
      id: JOB_ID,
      number: "J00100",
      status: "SCHEDULED",
      location: "123 Main St",
      customer: { id: CUSTOMER_ID, name: "Acme Plumbing", phone: "2125551000" },
    },
  ],
  identity: null,
};

const EMPTY_RESULT = {
  query: { isPhone: false, e164: null },
  customers: [],
  jobs: [],
  identity: null,
};

// ── Seam mocks ──────────────────────────────────────────────────────────────
// These specs render deep phone components without a QueryClientProvider - every
// data hook is stubbed individually. Times now resolve against the ORG's zone, so
// the org query joins that list; pinned here so the rendered clock is fixed rather
// than the runner's.
vi.mock("@/lib/api/organization", () => ({
  useOrganization: () => ({ data: { timezone: "America/New_York" } }),
}));

vi.mock("@/lib/api/communication", () => ({
  BUSINESS_NUMBER: "(551) 282-7064",
  DISPOSITION_LABELS: {},
  fmtPhone: (n: string) => n,
  useCalls: () => ({ data: [] }),
  useMessageThreads: () => ({ data: [] }),
  usePhoneAgents: () => ({ data: [] }),
  usePlaceCall: () => ({ mutate: vi.fn(), isPending: false }),
  useStashCallAttribution: () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  useCallOutcome: () => ({ data: null }),
  usePhoneCustomers: () => ({ data: [] }),
  // Server-side search seam: "acme" matches, anything else is empty — the
  // component no longer filters client-side.
  useDialerSearch: (q: string) => ({
    data: q.toLowerCase().includes("acme") ? ACME_RESULT : EMPTY_RESULT,
    isFetching: false,
  }),
}));

vi.mock("@/lib/api/inventory", () => ({
  usePurchaseOrders: () => ({ data: [] }),
  useTechs: () => ({ data: [] }),
}));

// Task B2 — the resolved caller-ID fetch (the embedded <Softphone/>'s
// office-softphone path) is out of scope for this suite; stub it to no data.
vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

vi.mock("@/components/communication/phone/shared", () => ({
  dayLabel: () => "day",
  shortTime: () => "time",
  DirIcon: () => null,
}));

import { DialerWorkspace } from "../Dialer";

function setup() {
  render(
    <MemoryRouter>
      <DialerWorkspace calls={[]} onToast={() => {}} />
    </MemoryRouter>,
  );
  return screen.getByPlaceholderText("Search a job #, customer, or phone…");
}

// The search can legitimately surface the same customer more than once (a
// customer row AND a job row carrying the customer name), so always use *AllBy*.
const resultButtons = () =>
  screen.queryAllByRole("button", { name: /Acme Plumbing/ });

describe("Dialer search dropdown (#356)", () => {
  it("opens the results dropdown when typing and shows matches", async () => {
    const input = setup();
    await userEvent.type(input, "Acme");
    const buttons = await screen.findAllByRole("button", { name: /Acme Plumbing/ });
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("closes the dropdown, empties the input, and keeps it closed after selecting a result", async () => {
    const input = setup();
    await userEvent.type(input, "Acme");
    const buttons = await screen.findAllByRole("button", { name: /Acme Plumbing/ });
    await userEvent.click(buttons[0]!);

    await waitFor(() => {
      expect(resultButtons()).toHaveLength(0);
      expect(screen.queryByText(/No customer or job matches/)).not.toBeInTheDocument();
      expect(input).toHaveValue("");
    });

    // Stays closed while the input retains focus (no reopen on re-render).
    input.focus();
    expect(resultButtons()).toHaveLength(0);
  });

  it("closes the dropdown on Escape without selecting", async () => {
    const input = setup();
    await userEvent.type(input, "Acme");
    expect(
      await screen.findAllByRole("button", { name: /Acme Plumbing/ }),
    ).not.toHaveLength(0);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(resultButtons()).toHaveLength(0));
    // Nothing selected — query untouched, no customer panel loaded.
    expect(input).toHaveValue("Acme");
  });

  it("closes the dropdown on an outside mousedown", async () => {
    const input = setup();
    await userEvent.type(input, "Acme");
    expect(
      await screen.findAllByRole("button", { name: /Acme Plumbing/ }),
    ).not.toHaveLength(0);

    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(resultButtons()).toHaveLength(0));
  });

  it("shows the empty state only while actively searching", async () => {
    const input = setup();
    await userEvent.type(input, "zzz-no-match");
    expect(
      await screen.findByText(/No customer or job matches/),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText(/No customer or job matches/)).not.toBeInTheDocument(),
    );
  });
});
