/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions S08.12 - the Dialer's recent-activity rows follow View transcript too: the call summary line and
// the transcript toggle are for holders of the switch only, and nothing asks the server for a transcript without it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const useCallTranscript = vi.hoisted(() => vi.fn());

vi.mock("@/components/contact/useContactPolicyInput", () => ({
  useContactPolicyInput: () => ({
    switches: { copyCustomerPhone: true, copyCustomerEmail: true, contactCustomers: true, viewCustomers: true },
    phoneService: true,
  }),
}));

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
import { AbilityProvider } from "@/contexts/AbilityContext";
import { abilityWithSwitches, catalogToggle, presetSwitchLabels } from "@/__tests__/support/backendSwitchCatalog";

const SUMMARY = "Booked the Thursday visit.";
const CALL: CallSession = {
  id: "cc000000-0000-0000-0000-000000000002",
  direction: "inbound",
  fromNumber: "+16095551234",
  toNumber: "+12019037784",
  status: "completed",
  answeredBy: { kind: "none" },
  startedAt: new Date().toISOString(),
  customerId: "cust-1",
  summary: SUMMARY,
} as CallSession;

const SELECTION: DialerSelection = {
  customer: { id: "cust-1", name: "Pat Lee", phone: "+16095551234" },
  jobs: [],
};

function renderPanel(labels: string[], call: CallSession = CALL) {
  return render(
    <MemoryRouter>
      <AbilityProvider ability={abilityWithSwitches(...labels)}>
        <CustomerPanel selection={SELECTION} calls={[call]} onCall={vi.fn()} />
      </AbilityProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCallTranscript.mockReturnValue({ data: undefined, isLoading: false });
});

describe("the Dialer's recent activity follows View transcript", () => {
  it("with the Dispatcher preset's values shows the call summary and the transcript toggle", () => {
    expect(catalogToggle("View transcript").presets.DISPATCHER).toBe(true);
    renderPanel(presetSwitchLabels("DISPATCHER"));

    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view transcript/i })).toBeInTheDocument();
  });

  it("with the Technician preset's values shows the row without a summary or a transcript toggle", () => {
    expect(catalogToggle("View transcript").presets.TECHNICIAN).toBe(false);
    // Even if the summary arrived, a person without the switch is shown none.
    renderPanel(presetSwitchLabels("TECHNICIAN"));

    expect(screen.getByText("Recent activity")).toBeInTheDocument();
    expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /view transcript/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/No transcript available/)).not.toBeInTheDocument();
  });

  it("never asks the server for a transcript without the switch", () => {
    renderPanel(presetSwitchLabels("TECHNICIAN"));

    for (const [, enabled] of useCallTranscript.mock.calls) expect(enabled).toBe(false);
  });

  it("asks for it, on expanding a row, with the switch", () => {
    // View transcript needs View communication.
    renderPanel(["View transcript", "View communication"]);
    fireEvent.click(screen.getByRole("button", { name: /view transcript/i }));

    expect(useCallTranscript).toHaveBeenCalledWith(CALL.id, true);
  });
});
