/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions S08.11 - the call drawer shows the recording player only with Play recording and the download
// control only with Download recording. The drawer is the one the Phone page opens from a call row (and the record tabs
// open the same component, see job-tab-call-recording-switches.test.tsx).
//
// The switch values are the built-in roles' preset columns, read from the backend catalog file itself (the module is
// not importable into the browser build), and compiled into the same ability rules the server's grants produce.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AbilityProvider } from "@/contexts/AbilityContext";
import { buildAbility, type AbilityRule } from "@/lib/ability";
import { catalogToggle, type PresetRole } from "@/__tests__/support/backendSwitchCatalog";

const useCallTranscript = vi.hoisted(() => vi.fn());
const playLink = vi.hoisted(() => vi.fn());
const downloadLink = vi.hoisted(() => vi.fn());

// Customer numbers on the Communication screens follow the person's switches (S05.6). This suite renders the
// screen without a query client, so the person's switches are stubbed: every one on, the screen as it always was.
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
  usePhoneCustomers: () => ({ data: [] }),
  usePhoneAgents: () => ({ data: [] }),
  useCustomerJobs: () => ({ data: [] }),
  useCustomerLeads: () => ({ data: [] }),
  useJobSearch: () => ({ data: [] }),
  useLeadSearch: () => ({ data: [] }),
  ATTACH_SEARCH_MIN: 2,
  useRecordingUrl: () => ({ refetch: playLink, isFetching: false }),
  useRecordingDownloadUrl: () => ({ refetch: downloadLink, isFetching: false }),
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

/** What each switch compiles into on the server (switches/catalog.ts `grants`). */
const RECORDING_SWITCHES: Array<[label: string, action: "play_recording" | "download_recording"]> = [
  ["Play recording", "play_recording"],
  ["Download recording", "download_recording"],
];

/** The ability rules of a built-in role's preset values for the two recording switches. */
function presetRules(role: PresetRole): AbilityRule[] {
  return RECORDING_SWITCHES.filter(([label]) => catalogToggle(label).presets[role]).map(([, action]) => ({
    action,
    subject: "Communication",
  }));
}

const RECORDED: CallSession = {
  id: "cd000000-0000-0000-0000-000000000009",
  direction: "inbound",
  fromNumber: "+15551230000",
  toNumber: "+12019037784",
  status: "completed",
  answeredBy: { kind: "none" },
  startedAt: new Date().toISOString(),
  durationSec: 42,
  hasRecording: true,
} as CallSession;

/** What the server sends a person who holds neither switch: the call, with no "has recording" field. */
const { hasRecording: _omitted, ...WITHOUT_FIELD } = RECORDED;
const NO_FIELD = WITHOUT_FIELD as CallSession;

// The drawer's transcript reader is behind View transcript (S08.12), which these cases are not about: every person
// below also holds it, so the recording switches are the only thing that varies.
const READS_TRANSCRIPTS: AbilityRule = { action: "view_transcript", subject: "Communication" };

function renderDrawer(rules: AbilityRule[], call: CallSession = RECORDED) {
  return render(
    <MemoryRouter>
      <AbilityProvider ability={buildAbility([...rules, READS_TRANSCRIPTS])}>
        <CallDetailDrawer call={call} onClose={vi.fn()} onToast={vi.fn()} />
      </AbilityProvider>
    </MemoryRouter>,
  );
}

const player = () => screen.queryByRole("button", { name: "Play" });
const downloadControl = () => screen.queryByRole("button", { name: "Download recording" });

beforeEach(() => {
  vi.clearAllMocks();
  useCallTranscript.mockReturnValue({ data: undefined, isLoading: false });
  playLink.mockResolvedValue({ data: { url: "https://files.example.test/play.mp3" } });
  downloadLink.mockResolvedValue({ data: { url: "https://files.example.test/download.mp3" } });
  // jsdom has no media playback.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

describe("the call drawer follows Play recording and Download recording", () => {
  it("with the Dispatcher preset's values shows a player and no download control", () => {
    // The expectation is derived from the catalog, so a changed preset changes what this proves.
    expect(catalogToggle("Play recording").presets.DISPATCHER).toBe(true);
    expect(catalogToggle("Download recording").presets.DISPATCHER).toBe(false);
    renderDrawer(presetRules("DISPATCHER"));

    expect(player()).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Seek recording" })).toBeInTheDocument();
    expect(downloadControl()).not.toBeInTheDocument();
  });

  it("with the Technician preset's values shows neither, and says nothing about a recording", () => {
    expect(catalogToggle("Play recording").presets.TECHNICIAN).toBe(false);
    expect(catalogToggle("Download recording").presets.TECHNICIAN).toBe(false);
    // The server leaves the field out for this person; the screen must not invent a "not recorded" line either.
    renderDrawer(presetRules("TECHNICIAN"), NO_FIELD);

    expect(player()).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Seek recording" })).not.toBeInTheDocument();
    expect(downloadControl()).not.toBeInTheDocument();
    expect(screen.queryByText("No recording for this call")).not.toBeInTheDocument();
    expect(screen.queryByText("This call was not recorded.")).not.toBeInTheDocument();
  });

  it("shows no player and no download control to a person without either switch even if a recording flag arrives", () => {
    renderDrawer(presetRules("TECHNICIAN"), RECORDED);

    expect(player()).not.toBeInTheDocument();
    expect(downloadControl()).not.toBeInTheDocument();
  });

  it("with the Admin preset's values shows the player and the download control", () => {
    renderDrawer(presetRules("ADMIN"));

    expect(player()).toBeInTheDocument();
    expect(downloadControl()).toBeInTheDocument();
  });

  it("offers just the download control to a person with Download recording and without Play recording", () => {
    renderDrawer([{ action: "download_recording", subject: "Communication" }]);

    expect(player()).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Seek recording" })).not.toBeInTheDocument();
    expect(downloadControl()).toBeInTheDocument();
  });

  it("still says a call was not recorded to a person who may hear recordings", () => {
    renderDrawer(presetRules("DISPATCHER"), { ...RECORDED, hasRecording: false } as CallSession);

    expect(screen.getByText("No recording for this call")).toBeInTheDocument();
    expect(player()).not.toBeInTheDocument();
  });

  it("downloads through the download link, never the playback link, and saves the file it hands out", async () => {
    const clicked: Array<{ href: string; download: string }> = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    renderDrawer(presetRules("ADMIN"));

    fireEvent.click(downloadControl()!);

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(downloadLink).toHaveBeenCalledTimes(1);
    expect(playLink).not.toHaveBeenCalled();
    expect(clicked[0]!.href).toBe("https://files.example.test/download.mp3");
    click.mockRestore();
  });

  it("plays through the playback link, never the download link", async () => {
    renderDrawer(presetRules("ADMIN"));
    fireEvent.click(player()!);

    await waitFor(() => expect(playLink).toHaveBeenCalledTimes(1));
    expect(downloadLink).not.toHaveBeenCalled();
  });

  it("tells the person quietly when the download is refused or the recording is not ready", async () => {
    downloadLink.mockResolvedValue({ data: undefined, error: { response: { status: 404 } } });
    renderDrawer([{ action: "download_recording", subject: "Communication" }]);

    fireEvent.click(downloadControl()!);

    expect(await screen.findByText(/still processing/i)).toBeInTheDocument();
  });

  describe("the transcript reader", () => {
    const TURNS = [
      { speaker: "Caller", text: "Can you hear me?", channel: 1, startSec: 0.5, endSec: 2.1 },
      { speaker: "Agent", text: "Yes, go ahead.", channel: 2, startSec: 2.4, endSec: 3.9 },
    ];

    it("carries a player in its footer for a person with Play recording, and none without", () => {
      useCallTranscript.mockReturnValue({ data: { transcript: null, summary: null, turns: TURNS }, isLoading: false });
      const { unmount } = renderDrawer(presetRules("DISPATCHER"));
      fireEvent.click(screen.getByText(/Open transcript/));
      expect(screen.getByRole("dialog", { name: "Transcript" })).toBeInTheDocument();
      // One player in the drawer, one in the reader (the open dialog hides the drawer from the accessibility tree).
      expect(screen.getAllByRole("slider", { name: "Seek recording", hidden: true })).toHaveLength(2);
      unmount();

      renderDrawer([{ action: "download_recording", subject: "Communication" }]);
      fireEvent.click(screen.getByText(/Open transcript/));
      expect(screen.getByRole("dialog", { name: "Transcript" })).toBeInTheDocument();
      expect(screen.queryAllByRole("slider", { name: "Seek recording", hidden: true })).toHaveLength(0);
    });
  });
});
