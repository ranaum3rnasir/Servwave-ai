/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions S08.12 - View transcript covers the transcript AND the call summary. Without it the call drawer
// (the one the Phone page opens from a call row; the record tabs open the same component, see
// job-tab-call-transcript-switch.test.tsx) shows neither, asks the server for neither, and says nothing about whether a
// transcript or an insight exists. No transcript download is offered whatever the switches.
//
// The switch values are the built-in roles' preset columns, read from the backend catalog file itself (the module is
// not importable into the browser build), and compiled into the same ability rules the server's grants produce.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AbilityProvider } from "@/contexts/AbilityContext";
import type { AppAbility } from "@/lib/ability";
import {
  abilityWithSwitches,
  catalogToggle,
  presetSwitchLabels,
  type PresetRole,
} from "@/__tests__/support/backendSwitchCatalog";

const useCallTranscript = vi.hoisted(() => vi.fn());

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
  useRecordingUrl: () => ({ data: undefined, refetch: vi.fn(), isFetching: false }),
  useRecordingDownloadUrl: () => ({ data: undefined, refetch: vi.fn(), isFetching: false }),
  useCallTranscript,
  DISPOSITION_LABELS: {},
  fmtPhone: (n: string) => n,
}));

vi.mock("@/lib/api/callJob", () => ({
  useReassignCallJob: () => ({ mutate: vi.fn(), isPending: false }),
  useReassignCallLead: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/useIsDemoOrg", () => ({ useIsDemoOrg: () => false }));
vi.mock("@/lib/communication/phoneTabHandoff", () => ({ requestCall: vi.fn() }));

import { CallDetailDrawer } from "../CallsView";
import type { CallSession } from "@/lib/api/communication";

/** The ability of a built-in role's preset values for every switch. */
const abilityOf = (role: PresetRole): AppAbility => abilityWithSwitches(...presetSwitchLabels(role));

const SUMMARY = "Confirmed Thursday 8am and asked for a certificate of insurance.";
const TRANSCRIPT = "Hi, can you come Thursday morning? Yes, eight works.";
const TURNS = [
  { speaker: "Caller", text: "Can you hear me?", channel: 1, startSec: 0.5, endSec: 2.1 },
  { speaker: "Agent", text: "Yes, go ahead.", channel: 2, startSec: 2.4, endSec: 3.9 },
];

/** What the server sends a person who holds View transcript. */
const SPOKEN_CALL: CallSession = {
  id: "cd000000-0000-0000-0000-00000000000a",
  direction: "inbound",
  fromNumber: "+15551230000",
  toNumber: "+12019037784",
  status: "completed",
  answeredBy: { kind: "none" },
  startedAt: new Date().toISOString(),
  durationSec: 42,
  summary: SUMMARY,
  transcriptPreview: TRANSCRIPT,
} as CallSession;

/** What it sends everyone else: the same call with no summary and no transcript field. */
const { summary: _summary, transcriptPreview: _transcriptPreview, ...WITHOUT } = SPOKEN_CALL;
const SILENT_CALL = WITHOUT as CallSession;

/** The drawer wraps the stored text in quotation marks, so match on containing it. */
const spokenText = (text: string) => (content: string) => content.includes(text);

function renderDrawer(ability: AppAbility, call: CallSession) {
  return render(
    <MemoryRouter>
      <AbilityProvider ability={ability}>
        <CallDetailDrawer call={call} onClose={vi.fn()} onToast={vi.fn()} />
      </AbilityProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCallTranscript.mockReturnValue({ data: undefined, isLoading: false });
});

describe("the call drawer follows View transcript", () => {
  it("with the Dispatcher preset's values shows the call summary and the transcript", () => {
    expect(catalogToggle("View transcript").presets.DISPATCHER).toBe(true);
    renderDrawer(abilityOf("DISPATCHER"), SPOKEN_CALL);

    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.getByText(spokenText(TRANSCRIPT))).toBeInTheDocument();
    expect(screen.getByText("Transcript")).toBeInTheDocument();
    expect(useCallTranscript).toHaveBeenLastCalledWith(SPOKEN_CALL.id, false);
  });

  it("with the Technician preset's values shows no summary, no transcript and no line about either", () => {
    expect(catalogToggle("View transcript").presets.TECHNICIAN).toBe(false);
    renderDrawer(abilityOf("TECHNICIAN"), SILENT_CALL);

    expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument();
    expect(screen.queryByText("Transcript")).not.toBeInTheDocument();
    expect(screen.queryByText("Call insights")).not.toBeInTheDocument();
    expect(screen.queryByText(/Open transcript/)).not.toBeInTheDocument();
    // The server sent nothing, so the screen must not invent an "empty" or "still loading" line either.
    expect(screen.queryByText("No transcript available for this call.")).not.toBeInTheDocument();
    expect(screen.queryByText("No AI insight for this call.")).not.toBeInTheDocument();
    expect(screen.queryByText(/still being generated/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading transcript/)).not.toBeInTheDocument();
  });

  it("asks the server for no transcript without the switch, even for a call that has none stored", () => {
    renderDrawer(abilityOf("TECHNICIAN"), SILENT_CALL);

    // The transcript route would refuse this person: the lazy fetch must stay switched off.
    expect(useCallTranscript).toHaveBeenCalled();
    for (const [, enabled] of useCallTranscript.mock.calls) expect(enabled).toBe(false);
  });

  it("shows nothing that was said to a person without the switch even if the fields arrive", () => {
    useCallTranscript.mockReturnValue({ data: { transcript: TRANSCRIPT, summary: SUMMARY, turns: TURNS }, isLoading: false });
    renderDrawer(abilityOf("TECHNICIAN"), SPOKEN_CALL);

    expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument();
    expect(screen.queryByText(spokenText(TRANSCRIPT))).not.toBeInTheDocument();
    expect(screen.queryByText(/Can you hear me/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Open transcript/)).not.toBeInTheDocument();
  });

  it("works from the switch alone: a custom role with View transcript on and every other call switch off still reads it", () => {
    // View transcript needs View communication.
    renderDrawer(abilityWithSwitches("View communication", "View transcript"), SPOKEN_CALL);

    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.getByText(spokenText(TRANSCRIPT))).toBeInTheDocument();
  });

  it("keeps the review flag, which is not part of what was said but a call insight (S08.13), when View transcript is off", () => {
    // See call insights needs View communication.
    renderDrawer(abilityWithSwitches("View communication", "See call insights"), { ...SILENT_CALL, reviewFlag: "Needs a manager's look" } as CallSession);

    expect(screen.getByText("Needs a manager's look")).toBeInTheDocument();
    expect(screen.queryByText("Transcript")).not.toBeInTheDocument();
  });
});

describe("no transcript download exists, whatever the switches", () => {
  const TRANSCRIPT_DOWNLOAD = /download.{0,20}transcript|transcript.{0,20}download|save.{0,20}transcript|export.{0,20}transcript/i;

  it("offers none in the drawer or its reader to a person holding every switch, Download transcript included", () => {
    useCallTranscript.mockReturnValue({ data: { transcript: TRANSCRIPT, summary: SUMMARY, turns: TURNS }, isLoading: false });
    // Every toggle the Admin preset turns on, and Download transcript named outright.
    renderDrawer(abilityWithSwitches(...presetSwitchLabels("ADMIN"), "Download transcript"), SPOKEN_CALL);

    expect(screen.queryByRole("button", { name: TRANSCRIPT_DOWNLOAD })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: TRANSCRIPT_DOWNLOAD })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Open transcript/));
    expect(screen.getByRole("dialog", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: TRANSCRIPT_DOWNLOAD, hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: TRANSCRIPT_DOWNLOAD, hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByText(TRANSCRIPT_DOWNLOAD)).not.toBeInTheDocument();
  });
});
