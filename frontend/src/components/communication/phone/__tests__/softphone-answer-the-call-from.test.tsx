/// <reference types="@testing-library/jest-dom/vitest" />
// #3025 (parent #3013): the call screen tells you to answer the call from the number the call goes out from.
//
// ServWave rings your own phone first and dials the customer only when you answer. Once a call is placed, the call screen
// says "Your phone will ring first. Answer the call from {number} to connect.", where {number} is the number the call goes
// out from, then "It will be logged to {record}." when the call has a record. The copy is the issue's, word for word.
//
// The dialer runs on its bridge path (no in-browser phone, as everywhere but the phone tab). The API is answered at the
// network edge (the app's HTTP client): the number the call goes out from is the server's answer, or the number picked on
// the phone page (handed over with the pick; that page's wiring is proven in phone-tab-on-a-phone.test.tsx).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import api from "@/lib/axios";
import { renderWithProviders } from "@/__tests__/helpers";
import { Softphone } from "../Softphone";
import type { DialerEntityContext } from "@/stores/dialer.store";

const http = api as unknown as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

const OUR_NUMBER = "(555) 010-1509";
const PICKED_NUMBER = "(555) 010-1111";

/** The server: the caller's own outgoing number, and a placed bridge call (no call row yet). */
function serverAnswers() {
  http.get.mockImplementation((url: string) => {
    if (url === "/api/communication/my-outbound-number") {
      return Promise.resolve({
        data: { provider_number_id: "TPN-OURS", phone_number_id: "pn-ours", formatted: OUR_NUMBER, label: "Main line" },
      });
    }
    if (url === "/api/communication/calls/outcome") return Promise.resolve({ data: { call: null } });
    if (url === "/api/communication/contacts") return Promise.resolve({ data: { contacts: [] } });
    return Promise.resolve({ data: {} });
  });
  http.post.mockImplementation((url: string) =>
    url === "/api/communication/calls"
      ? Promise.resolve({ data: { queued: true, outcome_since: new Date().toISOString() } })
      : Promise.resolve({ data: {} }),
  );
}

async function placeCall(props: Partial<React.ComponentProps<typeof Softphone>> = {}) {
  renderWithProviders(<Softphone prefillNumber="5550105252" {...props} />);
  // The outgoing number is known before the call is placed (the dialer names it up front).
  if (!props.callerIdNumberId) await screen.findByText(`Calling from Main line ${OUR_NUMBER}`);
  await userEvent.click(screen.getByRole("button", { name: "Call" }));
  await screen.findAllByText("Call placed");
}

/** What the call screen says, line by line (its status lines). */
function statusLines(): string[] {
  return screen.queryAllByRole("status").map((el) => el.textContent ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  serverAnswers();
});

describe("the call screen once a call is placed", () => {
  const RECORDS: Array<{ name: string; context: DialerEntityContext | undefined; copy: string }> = [
    {
      name: "a call with no record",
      context: undefined,
      copy: `Your phone will ring first. Answer the call from ${OUR_NUMBER} to connect.`,
    },
    {
      name: "a call placed from a job",
      context: { jobId: "11111111-1111-4111-8111-111111111111", jobLabel: "J00042" },
      copy: `Your phone will ring first. Answer the call from ${OUR_NUMBER} to connect. It will be logged to J00042.`,
    },
    {
      name: "a call placed from a lead",
      context: { leadId: "22222222-2222-4222-8222-222222222222", leadLabel: "L00017" },
      copy: `Your phone will ring first. Answer the call from ${OUR_NUMBER} to connect. It will be logged to L00017.`,
    },
  ];

  it.each(RECORDS)("names the outgoing number to answer: $name", async ({ context, copy }) => {
    await placeCall({ entityContext: context });

    expect(statusLines()).toContain(copy);
    // The old line, which never named the number, is gone.
    expect(screen.queryByText(/answer to connect/)).not.toBeInTheDocument();
  });

  it("names the number picked to call from, when one was picked on the phone page", async () => {
    // The phone page hands the pick over with how it reads, both off the caller's own allow-list.
    await placeCall({ callerIdNumberId: "pn-picked", callerIdNumber: PICKED_NUMBER });

    expect(statusLines()).toContain(`Your phone will ring first. Answer the call from ${PICKED_NUMBER} to connect.`);
    // The picked number goes to the server with the call.
    expect(http.post).toHaveBeenCalledWith(
      "/api/communication/calls",
      expect.objectContaining({ from_number_id: "pn-picked" }),
    );
  });
});
