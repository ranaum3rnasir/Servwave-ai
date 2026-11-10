/// <reference types="@testing-library/jest-dom/vitest" />
// #3025 (parent #3013): an outbound call that never reached anyone reads "Not connected" in the call history, never
// "Completed". The call ingest stores such a call as missed (backend call-statuses-tell-truth-db.test.ts); here, the call
// history label for each way a call can end, in the two places the call history names a call's outcome in words: the
// call log's card (on a phone) and the call's detail panel (also opened from a customer's, lead's or job's Communication
// tab). The API is answered at the network edge (the app's HTTP client); no module of ours is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import api from "@/lib/axios";
import { renderWithProviders } from "@/__tests__/helpers";
import { PHONE_PORTRAIT, emulateDevice } from "@/__tests__/support/deviceShape";
import { CallDetailDrawer, CallsView } from "../CallsView";
import type { CallSession } from "@/lib/api/communication";

const http = api as unknown as { get: ReturnType<typeof vi.fn> };

/** What the server answers for each read the call history makes; nothing here is about the call's outcome. */
function serverAnswers() {
  http.get.mockImplementation((url: string) => {
    if (url.includes("/contacts")) return Promise.resolve({ data: { contacts: [] } });
    if (url.includes("/agents")) return Promise.resolve({ data: { agents: [] } });
    return Promise.resolve({ data: {} });
  });
}

const call = (id: string, direction: CallSession["direction"], status: CallSession["status"]): CallSession => ({
  id,
  direction,
  fromNumber: direction === "outbound" ? "+15550101509" : "+15550105252",
  toNumber: direction === "outbound" ? "+15550105252" : "+15550101509",
  status,
  answeredBy: { kind: "none" },
  startedAt: "2026-11-04T15:00:00.000Z",
  durationSec: 0,
});

/** Each way a call can end, and the word the call history uses for it. */
const LABELS: Array<{ name: string; call: CallSession; label: string }> = [
  {
    name: "an outbound call you never answered",
    call: call("cd000000-0000-4000-8000-000000000001", "outbound", "missed"),
    label: "Not connected",
  },
  {
    name: "an incoming call nobody answered",
    call: call("cd000000-0000-4000-8000-000000000002", "inbound", "missed"),
    label: "Missed",
  },
  {
    name: "an outbound call that connected",
    call: { ...call("cd000000-0000-4000-8000-000000000003", "outbound", "completed"), durationSec: 74 },
    label: "Completed",
  },
  {
    name: "an incoming call that was answered",
    call: { ...call("cd000000-0000-4000-8000-000000000004", "inbound", "completed"), durationSec: 61 },
    label: "Completed",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  serverAnswers();
});

describe("the call history label", () => {
  describe("on the call log's card (a phone)", () => {
    let restoreDevice: (() => void) | null = null;
    beforeEach(() => {
      restoreDevice = emulateDevice({ ...PHONE_PORTRAIT, viewportWidth: 390 });
    });
    afterEach(() => {
      restoreDevice?.();
      restoreDevice = null;
    });

    it.each(LABELS)("$name reads $label", ({ call: c, label }) => {
      renderWithProviders(
        <CallsView calls={[c]} range={{ start: null, end: null }} focus="all" onClearFocus={vi.fn()} onToast={vi.fn()} />,
      );
      const card = within(screen.getByRole("list", { name: "Calls" })).getByRole("listitem");

      const direction = c.direction === "inbound" ? "Inbound" : "Outbound";
      expect(within(card).getByText(/^(Inbound|Outbound) · /).textContent).toBe(`${direction} · ${label}`);
    });
  });

  describe("on the call's detail panel", () => {
    it.each(LABELS)("$name reads $label", ({ call: c, label }) => {
      renderWithProviders(<CallDetailDrawer call={c} onClose={vi.fn()} onToast={vi.fn()} />);

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).queryByText(label, { exact: true })).not.toBeNull();
      // An outbound call that never connected is never called completed, nor missed.
      if (label === "Not connected") {
        expect(within(dialog).queryByText("Completed", { exact: true })).not.toBeInTheDocument();
        expect(within(dialog).queryByText("Missed", { exact: true })).not.toBeInTheDocument();
      }
    });
  });
});
