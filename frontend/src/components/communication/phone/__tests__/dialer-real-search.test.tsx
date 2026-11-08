// SLICE 2.2 — the dialer searches REAL tenant data through the canonical
// GET /api/communication/dialer-search endpoint (#666/#357). Contract:
//   • a customer result loads the customer panel with open-job chips that
//     deep-link to /jobs/:id (real UUIDs) + Call/Text actions,
//   • a job result loads its customer's panel with that job focused first,
//   • a phone-shaped query with no match offers Create customer / Create lead
//     prefilled with ?phone=<e164>,
//   • a resolved phone identity renders a "Recognized" banner that selects
//     the customer.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

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

const CUSTOMER_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_77_UUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOB_88_UUID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Holds the canned response the mocked useDialerSearch returns — assigned per
// test. vi.hoisted so the (hoisted) mock factory can close over it safely.
const seam = vi.hoisted(() => ({ result: null as unknown }));
// Stable place-call spy so the specs can assert the POSTed body (E2 attribution).
const placeCall = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));

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
  useDialerSearch: () => ({ data: seam.result, isFetching: false }),
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

const MATCH_RESULT = {
  query: { isPhone: false, e164: null },
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
  identity: null,
};

const NO_MATCH_PHONE = {
  query: { isPhone: true, e164: "+16095550000" },
  customers: [],
  jobs: [],
  identity: null,
};

const JOB_NO_CUSTOMER_UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const JOB_NO_CUSTOMER_RESULT = {
  query: { isPhone: false, e164: null },
  customers: [],
  jobs: [
    {
      id: JOB_NO_CUSTOMER_UUID,
      number: "J00099",
      status: "SCHEDULED",
      location: "3 Elm St, Hoboken",
      customer: null,
    },
  ],
  identity: null,
};

const IDENTITY_RESULT = {
  ...MATCH_RESULT,
  query: { isPhone: true, e164: "+15555550199" },
  identity: {
    kind: "customer",
    id: CUSTOMER_UUID,
    label: "ZZ-TEST CTM",
    customerId: CUSTOMER_UUID,
    leadId: null,
    vendorId: null,
  },
};

function setup() {
  render(
    <MemoryRouter>
      <DialerWorkspace calls={[]} onToast={() => {}} />
    </MemoryRouter>,
  );
  return screen.getByPlaceholderText("Search a job #, customer, or phone…");
}

beforeEach(() => {
  vi.clearAllMocks();
  seam.result = MATCH_RESULT;
});

describe("Dialer real search (slice 2.2)", () => {
  it("picking a customer result shows open-job chips that navigate, plus Call/Text actions", async () => {
    const input = setup();
    await userEvent.type(input, "zz-test");

    // Grouped dropdown: a customer row (name · phone · N open jobs)…
    const rows = await screen.findAllByRole("button", { name: /ZZ-TEST CTM/ });
    const customerRow = rows.find((r) => r.textContent?.includes("2 open jobs"));
    expect(customerRow).toBeTruthy();
    await userEvent.click(customerRow!);

    // Panel: both open jobs render as chips; a chip navigates to the REAL id.
    const chip77 = await screen.findByRole("button", { name: /J00077/ });
    expect(screen.getByRole("button", { name: /J00088/ })).toBeInTheDocument();
    await userEvent.click(chip77);
    expect(mockNavigate).toHaveBeenCalledWith(`/jobs/${JOB_77_UUID}`);

    // Call seeds the softphone dial field with the customer's number.
    await userEvent.click(screen.getByRole("button", { name: "Call customer" }));
    expect(screen.getByPlaceholderText("Enter a number")).toHaveValue("5555550199");

    // Text deep-links to the SMS center for this customer.
    await userEvent.click(screen.getByRole("button", { name: "Text customer" }));
    expect(mockNavigate).toHaveBeenCalledWith(
      `/communication/text?customerId=${CUSTOMER_UUID}`,
    );
  });

  it("picking a job result shows its customer panel with that job focused first", async () => {
    const input = setup();
    await userEvent.type(input, "J00088");

    // The Jobs group row reads "J00088 · customer · phone".
    const jobRow = (await screen.findAllByRole("button", { name: /J00088/ })).find(
      (r) => r.textContent?.includes("ZZ-TEST CTM"),
    );
    expect(jobRow).toBeTruthy();
    await userEvent.click(jobRow!);

    // Panel header is the job's customer; the picked job is the FIRST chip and
    // carries the focused treatment; the sibling open job still shows.
    expect(await screen.findByText("ZZ-TEST CTM")).toBeInTheDocument();
    const chips = screen.getAllByRole("button", { name: /J000\d\d/ });
    expect(chips[0]!.textContent).toContain("J00088");
    expect(chips[0]!.className).toContain("bg-primary/10");
    expect(chips.some((c) => c.textContent?.includes("J00077"))).toBe(true);
    // The focused job's location renders under the chips.
    expect(screen.getByText("2 Oak Ave, Jersey City")).toBeInTheDocument();
  });

  it("offers Create customer / Create lead for a phone-shaped query with no match", async () => {
    seam.result = NO_MATCH_PHONE;
    const input = setup();
    await userEvent.type(input, "6095550000");

    expect(await screen.findByText(/No match for/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Create customer/ }));
    expect(mockNavigate).toHaveBeenCalledWith(
      `/customers/new?phone=${encodeURIComponent("+16095550000")}`,
    );

    await userEvent.click(screen.getByRole("button", { name: /Create lead/ }));
    expect(mockNavigate).toHaveBeenCalledWith(
      `/leads/new?phone=${encodeURIComponent("+16095550000")}`,
    );
  });

  it("attributes a hub call to the picked customer (E2): panel Call → place call posts customer_id", async () => {
    const input = setup();
    await userEvent.type(input, "zz-test");

    const rows = await screen.findAllByRole("button", { name: /ZZ-TEST CTM/ });
    await userEvent.click(rows.find((r) => r.textContent?.includes("2 open jobs"))!);

    // The panel's Call button seeds the softphone with the customer context…
    await userEvent.click(screen.getByRole("button", { name: "Call customer" }));
    // …so placing the call posts customer_id (no job/lead — hub call).
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(placeCall.mutate).toHaveBeenCalledTimes(1);
    const body = placeCall.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.customer_id).toBe(CUSTOMER_UUID);
    expect(body.to_number).toBe("+15555550199");
    expect(body).not.toHaveProperty("job_id");
    expect(body).not.toHaveProperty("lead_id");
  });

  it("attributes a job-pick call to that JOB (o4g): job row → panel Call posts job_id + customer_id", async () => {
    // Live QA 2026-07-21: picking a job in the dialer search dropped the job
    // on the floor — the call attributed to the customer only and never
    // reached the job's Communication tab. The picked (focused) job must ride
    // the context into the placed call.
    const input = setup();
    await userEvent.type(input, "J00088");

    const jobRow = (await screen.findAllByRole("button", { name: /J00088/ })).find(
      (r) => r.textContent?.includes("ZZ-TEST CTM"),
    );
    await userEvent.click(jobRow!);

    await userEvent.click(screen.getByRole("button", { name: "Call customer" }));
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(placeCall.mutate).toHaveBeenCalledTimes(1);
    const body = placeCall.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.job_id).toBe(JOB_88_UUID);
    expect(body.customer_id).toBe(CUSTOMER_UUID);
    expect(body.to_number).toBe("+15555550199");
  });

  it("seeds the job context on the job pick itself — dialing the prefill posts job_id", async () => {
    const input = setup();
    await userEvent.type(input, "J00088");

    const jobRow = (await screen.findAllByRole("button", { name: /J00088/ })).find(
      (r) => r.textContent?.includes("ZZ-TEST CTM"),
    );
    await userEvent.click(jobRow!);

    // No panel click — the pick already seeded the softphone prefill+context.
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    const body = placeCall.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.job_id).toBe(JOB_88_UUID);
    expect(body.customer_id).toBe(CUSTOMER_UUID);
  });

  it("a job hit with no customer on file still attributes job_id when manually dialed (o4g residual gap)", async () => {
    // Root cause (o4g): ready() gated the ENTIRE entity context on customerId
    // being present, and returned before setting anything at all when there
    // was no phone to prefill (this job's customer is null) — so a picked
    // job with no customer silently dropped its job_id from the eventual
    // call, even though the job WAS correctly picked in the UI.
    seam.result = JOB_NO_CUSTOMER_RESULT;
    const input = setup();
    await userEvent.type(input, "J00099");

    const jobRow = (await screen.findAllByRole("button", { name: /J00099/ }))[0]!;
    await userEvent.click(jobRow);

    // No customer/phone to auto-prefill — the dial field stays empty; the
    // user types a number by hand and calls.
    const dialInput = screen.getByPlaceholderText("Enter a number");
    expect(dialInput).toHaveValue("");
    await userEvent.type(dialInput, "2015550199");
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(placeCall.mutate).toHaveBeenCalledTimes(1);
    const body = placeCall.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.job_id).toBe(JOB_NO_CUSTOMER_UUID);
  });

  it("renders the Recognized identity banner and selects that customer on click", async () => {
    seam.result = IDENTITY_RESULT;
    const input = setup();
    await userEvent.type(input, "5555550199");

    const banner = await screen.findByRole("button", {
      name: /Recognized: ZZ-TEST CTM \(customer\)/,
    });
    await userEvent.click(banner);

    // Dropdown closes; the panel shows the recognized customer with its jobs.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Recognized/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("1 Main St, Newark")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /J00077/ })).toBeInTheDocument();
  });
});
