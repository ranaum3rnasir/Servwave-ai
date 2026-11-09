/// <reference types="@testing-library/jest-dom/vitest" />
// Mobile slice 71: the dialer's job and customer search is on a phone too.
//
// It used to be `hidden md:block`, with a line saying "Job search & call history are available on
// desktop". jsdom applies no stylesheet, so "shown below md" is asserted the way Tailwind decides it:
// an unprefixed `hidden` on the element or any ancestor hides it on a phone, while `md:block` only
// brings it back from 768 px up. The measured proof (the search box is on screen at 320 px, the
// pop-out page scrolls to its last control) is the mobile gate's `phone-page-fit` spec.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
      openJobs: [{ id: JOB_ID, number: "J00100", status: "SCHEDULED", location: "123 Main St" }],
    },
  ],
  jobs: [],
  identity: null,
};
const EMPTY_RESULT = { query: { isPhone: false, e164: null }, customers: [], jobs: [], identity: null };

// Customer numbers on the Communication screens follow the person's switches (S05.6). This suite renders the
// screen without a query client, so the person's switches are stubbed: every one on, the screen as it always was.
vi.mock("@/components/contact/useContactPolicyInput", () => ({
  useContactPolicyInput: () => ({
    switches: { copyCustomerPhone: true, copyCustomerEmail: true, contactCustomers: true, viewCustomers: true },
    phoneService: true,
  }),
}));

vi.mock("@/lib/api/shared/organization", () => ({
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
  useDialerSearch: (q: string) => ({
    data: q.toLowerCase().includes("acme") ? ACME_RESULT : EMPTY_RESULT,
    isFetching: false,
  }),
}));
vi.mock("@/lib/api/inventory", () => ({
  usePurchaseOrders: () => ({ data: [] }),
  useTechs: () => ({ data: [] }),
}));
vi.mock("@/lib/api/myOutboundNumber", () => ({ useMyOutboundNumber: () => ({ data: undefined }) }));
vi.mock("@/components/communication/phone/shared", () => ({
  dayLabel: () => "day",
  shortTime: () => "time",
  DirIcon: () => null,
}));

import { DialerWorkspace } from "../Dialer";

/** True when Tailwind would not draw this element on a phone: an unprefixed `hidden` on it or an ancestor. */
function hiddenOnAPhone(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) if (e.classList.contains("hidden")) return true;
  return false;
}

function setup() {
  render(
    <MemoryRouter>
      <DialerWorkspace calls={[]} onToast={() => {}} />
    </MemoryRouter>,
  );
  return screen.getByPlaceholderText("Search a job #, customer, or phone…");
}

describe("the dialer's job search on a phone", () => {
  it("is not hidden below md, and no longer says it is desktop-only", () => {
    const search = setup();
    expect(hiddenOnAPhone(search)).toBe(false);
    expect(screen.queryByText(/available on desktop/i)).toBeNull();
  });

  it("shows the picked customer and their open jobs below md, not only from md up", async () => {
    const search = setup();
    await userEvent.type(search, "Acme");
    await userEvent.click((await screen.findAllByRole("button", { name: /Acme Plumbing/ }))[0]!);
    const job = await screen.findByText("J00100");
    expect(hiddenOnAPhone(job)).toBe(false);
  });

  it("keeps the empty 'search your customers' placeholder for wide screens only", () => {
    setup();
    expect(hiddenOnAPhone(screen.getByText("Search your customers & jobs"))).toBe(true);
  });
});
