/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions S08.19 - the call drawer's attach menu follows "Attach conversations to jobs and leads".
// Without the switch the drawer shows where the call is filed but offers no way to change it; with it the menu is
// there, and a detach that takes the call out of the person's reach closes the drawer instead of leaving it open on a
// call they can no longer read.
//
// The switch values are the built-in roles' preset columns, read from the backend catalog file itself.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AbilityProvider } from "@/contexts/AbilityContext";
import { buildAbility, type AbilityRule } from "@/lib/ability";
import { catalogToggle, type PresetRole } from "@/__tests__/support/backendSwitchCatalog";

const reassignCallJob = vi.hoisted(() => vi.fn());
const reassignCallLead = vi.hoisted(() => vi.fn());

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
  usePhoneCustomers: () => ({ data: [] }),
  usePhoneAgents: () => ({ data: [] }),
  useCustomerJobs: () => ({ data: [] }),
  useCustomerLeads: () => ({ data: [] }),
  useJobSearch: () => ({ data: [] }),
  useLeadSearch: () => ({ data: [] }),
  ATTACH_SEARCH_MIN: 2,
  // #3024: what "Attach to a lead or job" offers for the call.
  useAttachMenuTargets: () => ({ data: { rule: "carriers", groups: [] }, isLoading: false }),
  useRecordingUrl: () => ({ refetch: vi.fn(), isFetching: false }),
  useRecordingDownloadUrl: () => ({ refetch: vi.fn(), isFetching: false }),
  useCallTranscript: () => ({ data: undefined, isLoading: false }),
  DISPOSITION_LABELS: {},
  fmtPhone: (n: string) => n,
}));

vi.mock("@/lib/api/callJob", () => ({
  useReassignCallJob: () => ({ mutate: reassignCallJob, isPending: false }),
  useReassignCallLead: () => ({ mutate: reassignCallLead, isPending: false }),
}));
vi.mock("@/lib/useIsDemoOrg", () => ({ useIsDemoOrg: () => false }));
vi.mock("@/lib/communication/phoneTabHandoff", () => ({ requestCall: vi.fn() }));

// Radix dropdown-menu internals touch scrollIntoView and floating-ui builds a ResizeObserver; jsdom has neither.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

import { CallDetailDrawer } from "../CallsView";
import type { CallSession } from "@/lib/api/communication";

const ATTACH_LABEL = "Attach conversations to jobs and leads";

/** The ability rules a built-in role's preset values give for the attach switch. */
function presetRules(role: PresetRole): AbilityRule[] {
  const toggle = catalogToggle(ATTACH_LABEL);
  return toggle.presets[role] ? toggle.grants.map((g) => ({ action: g.action, subject: g.subject }) as AbilityRule) : [];
}

const ON_A_JOB: CallSession = {
  id: "cd000000-0000-0000-0000-000000000019",
  direction: "inbound",
  fromNumber: "+15551230000",
  toNumber: "+12019037784",
  status: "completed",
  answeredBy: { kind: "none" },
  startedAt: new Date().toISOString(),
  durationSec: 42,
  jobId: "b0000000-0000-0000-0000-000000000042",
  jobLabel: "J00042",
} as CallSession;

const UNATTACHED: CallSession = { ...ON_A_JOB, jobId: undefined, jobLabel: undefined } as CallSession;

function renderDrawer(rules: AbilityRule[], call: CallSession) {
  const onClose = vi.fn();
  const onToast = vi.fn();
  render(
    <MemoryRouter>
      <AbilityProvider ability={buildAbility(rules)}>
        <CallDetailDrawer call={call} onClose={onClose} onToast={onToast} />
      </AbilityProvider>
    </MemoryRouter>,
  );
  return { onClose, onToast };
}

const attachButton = () => screen.queryByRole("button", { name: /Attach to job or lead/ });
const attachedButton = () => screen.queryByTitle(/Attached to J00042 - click to reassign/);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the call drawer follows Attach conversations to jobs and leads", () => {
  it("shows no attach menu to a person without the switch, on an unattached call or an attached one", () => {
    renderDrawer([], UNATTACHED);
    expect(attachButton()).not.toBeInTheDocument();
  });

  it("still says which job an attached call is filed on, with nothing to click", () => {
    renderDrawer([], ON_A_JOB);
    expect(screen.getAllByText("J00042").length).toBeGreaterThan(0);
    expect(attachedButton()).not.toBeInTheDocument();
  });

  it("shows no attach menu to a person who holds only Edit communication records", () => {
    renderDrawer([{ action: "update", subject: "Communication" }] as AbilityRule[], UNATTACHED);
    expect(attachButton()).not.toBeInTheDocument();
  });

  it("shows the attach menu on an unattached call with the switch on", () => {
    renderDrawer(presetRules("DISPATCHER"), UNATTACHED);
    expect(attachButton()).toBeInTheDocument();
  });

  it("shows the attach menu to a person on the Technician preset's values, whose role could not attach before", () => {
    // The expectation is derived from the catalog, so a changed preset changes what this proves.
    expect(catalogToggle(ATTACH_LABEL).presets.TECHNICIAN).toBe(true);
    renderDrawer(presetRules("TECHNICIAN"), ON_A_JOB);
    expect(attachedButton()).toBeInTheDocument();
  });

  it("closes the drawer, with a plain note and no error, when a detach takes the call out of the person's reach", async () => {
    // The server answers a detach of a call the person can no longer read with a success that says it left.
    reassignCallJob.mockImplementation((_vars, opts) => opts.onSuccess({ call: null, left: true }));
    const { onClose, onToast } = renderDrawer(presetRules("DISPATCHER"), ON_A_JOB);

    fireEvent.pointerDown(attachedButton()!, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /No lead or job/ }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(reassignCallJob).toHaveBeenCalledWith({ callId: ON_A_JOB.id, jobId: null }, expect.anything());
    expect(onToast).toHaveBeenCalledTimes(1);
    expect(onToast.mock.calls[0]![0]).not.toMatch(/couldn't|try again/i);
  });

  it("keeps the drawer open after a detach that leaves the call readable", async () => {
    reassignCallJob.mockImplementation((_vars, opts) => opts.onSuccess({ call: { id: ON_A_JOB.id } }));
    const { onClose, onToast } = renderDrawer(presetRules("DISPATCHER"), ON_A_JOB);

    fireEvent.pointerDown(attachedButton()!, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: /No lead or job/ }));

    await waitFor(() => expect(onToast).toHaveBeenCalledWith("Link removed"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
