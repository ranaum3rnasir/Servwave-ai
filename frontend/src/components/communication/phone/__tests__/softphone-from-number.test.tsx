// S05.22 - on the bridge path (no in-browser phone) the dialer says which number the call
// goes out from BEFORE it is placed, read from the same resolver the server uses
// (GET /api/communication/my-outbound-number). With no company number at all it says so in
// plain words. Uses the REAL useMyOutboundNumber hook (only the HTTP client is mocked), so the
// line is proven to come from the resolver's answer and not from a prop.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const http = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/axios", () => ({ default: http }));

// The browser phone: a stub the test swaps between "no phone" (bridge path) and a working one.
const softphone = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/communication/useCtmSoftphone", () => ({
  useCtmSoftphone: () => softphone.current,
}));

import { Softphone } from "../Softphone";

const NO_NUMBER_COPY = "No company number is set up for calls. Contact your admin.";
const MY_NUMBER_URL = "/api/communication/my-outbound-number";

function resolverAnswers(body: Record<string, unknown>) {
  http.get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === MY_NUMBER_URL ? body : { contacts: [] } }),
  );
}

function renderDialer(props: Partial<React.ComponentProps<typeof Softphone>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Softphone prefillNumber="5551234567" {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  softphone.current = null;
});

describe("Softphone - shows the number a call goes out from, on the bridge path", () => {
  it("says 'Calling from <label> <number>' for a number that has a label", async () => {
    resolverAnswers({
      provider_number_id: "TPN1",
      phone_number_id: "pn-1",
      formatted: "(201) 555-1234",
      label: "Service line",
    });
    renderDialer();

    expect(await screen.findByText("Calling from Service line (201) 555-1234")).toBeInTheDocument();
    expect(screen.queryByText(NO_NUMBER_COPY)).not.toBeInTheDocument();
  });

  it("says 'Calling from <number>' when the number has no label", async () => {
    resolverAnswers({
      provider_number_id: "TPN1",
      phone_number_id: "pn-1",
      formatted: "(201) 555-1234",
      label: null,
    });
    renderDialer();

    expect(await screen.findByText("Calling from (201) 555-1234")).toBeInTheDocument();
  });

  it("says nothing is set up when no company number resolves", async () => {
    resolverAnswers({ none: true });
    renderDialer();

    expect(await screen.findByText(NO_NUMBER_COPY)).toBeInTheDocument();
    expect(screen.queryByText(/^Calling from/)).not.toBeInTheDocument();
  });

  it("shows nothing while the answer is still loading, and nothing if it cannot be read", async () => {
    http.get.mockImplementation((url: string) =>
      url === MY_NUMBER_URL ? Promise.reject(new Error("offline")) : Promise.resolve({ data: { contacts: [] } }),
    );
    renderDialer();

    expect(await screen.findByRole("button", { name: "Call" })).toBeInTheDocument();
    expect(screen.queryByText(/^Calling from/)).not.toBeInTheDocument();
    expect(screen.queryByText(NO_NUMBER_COPY)).not.toBeInTheDocument();
  });

  it("is not drawn once the call is placed", async () => {
    resolverAnswers({ provider_number_id: "TPN1", phone_number_id: "pn-1", formatted: "(201) 555-1234", label: null });
    http.post.mockResolvedValue({ data: { outcome_since: "2026-10-08T10:00:00.000Z" } });
    renderDialer();
    await screen.findByText("Calling from (201) 555-1234");

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(await screen.findByText(/Your phone will ring first|Call ended/)).toBeInTheDocument();
    expect(screen.queryByText(/^Calling from/)).not.toBeInTheDocument();
  });

  it("leaves the /phone page's own picker to say it when a number was picked there", async () => {
    resolverAnswers({ provider_number_id: "TPN1", phone_number_id: "pn-1", formatted: "(201) 555-1234", label: null });
    renderDialer({ callerIdNumberId: "pn-2" });

    expect(await screen.findByRole("button", { name: "Call" })).toBeInTheDocument();
    expect(screen.queryByText(/^Calling from/)).not.toBeInTheDocument();
  });

  it("a refusal for no number reads in the same plain words, with nothing to buy", async () => {
    resolverAnswers({ provider_number_id: "TPN1", phone_number_id: "pn-1", formatted: "(201) 555-1234", label: null });
    http.post.mockRejectedValue(
      Object.assign(new Error("Request failed"), {
        response: { status: 409, data: { code: "NO_PHONE_NUMBER", error: "No phone number available to place calls from" } },
      }),
    );
    renderDialer();

    await userEvent.click(await screen.findByRole("button", { name: "Call" }));

    expect(await screen.findByText(NO_NUMBER_COPY)).toBeInTheDocument();
  });

  it("does not show the line on the in-browser phone path", async () => {
    softphone.current = {
      ready: true,
      fault: null,
      awaitingStart: false,
      call: vi.fn(),
      hangup: vi.fn(),
      mute: vi.fn(),
      onIncoming: () => () => {},
    };
    resolverAnswers({ provider_number_id: "TPN1", phone_number_id: "pn-1", formatted: "(201) 555-1234", label: null });
    renderDialer();

    expect(await screen.findByRole("button", { name: "Call" })).toBeInTheDocument();
    expect(screen.queryByText(/^Calling from/)).not.toBeInTheDocument();
  });

  it("shows the line when the in-browser phone has a fault and the call falls back to the bridge", async () => {
    softphone.current = {
      ready: false,
      fault: "unknown",
      awaitingStart: false,
      call: vi.fn(),
      hangup: vi.fn(),
      mute: vi.fn(),
      onIncoming: () => () => {},
    };
    resolverAnswers({ provider_number_id: "TPN1", phone_number_id: "pn-1", formatted: "(201) 555-1234", label: null });
    renderDialer();

    expect(await screen.findByText("Calling from (201) 555-1234")).toBeInTheDocument();
  });
});
