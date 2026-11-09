/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions S08.13 - the shared call table (the Call Tracking report renders it) follows the switches too:
// its Insights column is See call insights and its Revenue column is See company figures, so a person without the
// second is never shown a column of $0.00 where the server simply left the figure out.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AbilityProvider } from "@/contexts/AbilityContext";
import type { AppAbility } from "@/lib/ability";
import { abilityWithSwitches } from "@/__tests__/support/backendSwitchCatalog";

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
  DISPOSITION_LABELS: {},
  fmtPhone: (n: string) => n,
}));

import { CallsTable } from "../CallsTable";
import type { CallSession } from "@/lib/api/communication";

const CALL = {
  id: "cd000000-0000-4000-8000-0000000000aa",
  direction: "inbound",
  fromNumber: "+15551230000",
  toNumber: "+12019037784",
  status: "completed",
  answeredBy: { kind: "none" },
  startedAt: new Date().toISOString(),
  durationSec: 42,
  sentiment: "positive",
  revenue: 41200,
} as CallSession;

function headers(ability: AppAbility): (string | undefined)[] {
  render(
    <MemoryRouter>
      <AbilityProvider ability={ability}>
        <CallsTable calls={[CALL]} />
      </AbilityProvider>
    </MemoryRouter>,
  );
  return screen.getAllByRole("columnheader").map((h) => h.textContent?.trim());
}

describe("the shared call table follows See call insights and See company figures", () => {
  it("shows both columns to a person holding both switches", () => {
    // See call insights needs View communication; See company figures needs See prices.
    const columns = headers(abilityWithSwitches("See call insights", "See company figures", "View communication", "See prices"));
    expect(columns).toContain("Insights");
    expect(columns).toContain("Revenue");
    expect(screen.getByText("$41,200.00")).toBeInTheDocument();
  });

  it("shows neither to a person holding neither, and keeps Answered By", () => {
    const columns = headers(abilityWithSwitches("View communication"));
    expect(columns).not.toContain("Insights");
    expect(columns).not.toContain("Revenue");
    expect(columns).toContain("Answered By");
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
  });

  it("treats the two switches independently", () => {
    // See call insights needs View communication.
    const insightsOnly = headers(abilityWithSwitches("See call insights", "View communication"));
    expect(insightsOnly).toContain("Insights");
    expect(insightsOnly).not.toContain("Revenue");
  });
});
