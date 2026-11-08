// E2 — the softphone attributes placed calls: the on-page entity context posts
// job_id / lead_id / customer_id (only defined keys) on POST
// /api/communication/calls (bridge) or /calls/attribution (softphone), and the
// terminal "placed" copy names where the call will be logged. The context
// follows the ENTITY the dialer was opened from — editing the number does NOT
// drop it (a dispatcher editing to reach a cell is still calling about that
// job/lead); it clears when the dialer closes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stable place-call spy — success immediately lands the "placed" state, the
// real CTM click-to-call contract (webhook owns the CallSession row).
const placeCall = vi.hoisted(() => ({
  mutate: vi.fn(
    (_args: unknown, opts?: { onSuccess?: (d: unknown) => void }) => opts?.onSuccess?.({}),
  ),
  isPending: false,
}));

// The softphone stash mutation (POST /calls/attribution) — the WebRTC branch
// writes it before dialing. mutateAsync resolves by default.
const stashAttribution = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
  isPending: false,
}));

// The office WebRTC softphone hook return — null by default (bridge path); a
// softphone test sets `.current` to a fake device before rendering.
type FakeDevice = {
  call: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  ready: Promise<void>;
  awaitingStart: boolean;
};
const softphone = vi.hoisted(() => ({ current: null as null | FakeDevice }));

vi.mock("@/lib/api/communication", () => ({
  BUSINESS_NUMBER: "(551) 282-7064",
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useStashCallAttribution: () => stashAttribution,
  useCallOutcome: () => ({ data: null }),
}));

// Task B2 — the resolved caller-ID fetch is out of scope for this suite;
// stub it to no data so the office-softphone `call()` assertions below stay
// on their pre-B2 single-argument shape (covered separately by
// softphone-dialfrom.test.tsx).
vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

vi.mock("@/lib/communication/useCtmSoftphone", () => ({
  useCtmSoftphone: () => softphone.current,
}));

import { Softphone } from "../Softphone";

const JOB_CONTEXT = {
  jobId: "b0000000-0000-0000-0000-000000000001",
  jobLabel: "J00042",
  customerId: "c0000000-0000-0000-0000-000000000001",
  customerName: "Daniel Cohen",
};

beforeEach(() => {
  vi.clearAllMocks();
  softphone.current = null;
});

describe("Softphone entity-context attribution (E2)", () => {
  it("posts job_id + customer_id (and only defined keys) when the prefill carries a job context", async () => {
    render(<Softphone prefillNumber="5555550199" entityContext={JOB_CONTEXT} />);

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(placeCall.mutate).toHaveBeenCalledTimes(1);
    const body = placeCall.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      direction: "out",
      from_number: "(551) 282-7064",
      to_number: "+15555550199",
      status: "ringing",
      job_id: JOB_CONTEXT.jobId,
      customer_id: JOB_CONTEXT.customerId,
    });
    expect(body).not.toHaveProperty("lead_id");

    // Terminal copy names the job the call will be logged to.
    expect(
      screen.getByText("Your phone will ring first — this call will be logged to J00042."),
    ).toBeInTheDocument();
  });

  it("posts lead_id and names the lead in the placed copy for a lead context", async () => {
    render(
      <Softphone
        prefillNumber="5555550199"
        entityContext={{
          leadId: "e0000000-0000-0000-0000-000000000001",
          leadLabel: "L00007",
          customerId: "c0000000-0000-0000-0000-000000000001",
          customerName: "John Doe",
        }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    const body = placeCall.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.lead_id).toBe("e0000000-0000-0000-0000-000000000001");
    expect(body.customer_id).toBe("c0000000-0000-0000-0000-000000000001");
    expect(body).not.toHaveProperty("job_id");

    expect(
      screen.getByText("Your phone will ring first — this call will be logged to L00007."),
    ).toBeInTheDocument();
  });

  it("omits every attribution key and keeps the stock copy without a context", async () => {
    render(<Softphone prefillNumber="5555550199" />);

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    const body = placeCall.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      direction: "out",
      from_number: "(551) 282-7064",
      to_number: "+15555550199",
      status: "ringing",
    });

    expect(
      screen.getByText("Your phone will ring first — answer to connect."),
    ).toBeInTheDocument();
  });

  it("keeps the entity context when the number is edited after the prefill", async () => {
    render(<Softphone prefillNumber="5555550199" entityContext={JOB_CONTEXT} />);

    // Hand-edit the dial field — the context follows the entity you dialed from,
    // NOT the exact number (editing to reach a cell is still about this job).
    await userEvent.type(screen.getByPlaceholderText("Enter a number"), "9");
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    const body = placeCall.mutate.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.to_number).toBe("+155555501999");
    expect(body.job_id).toBe(JOB_CONTEXT.jobId);
    expect(body.customer_id).toBe(JOB_CONTEXT.customerId);

    expect(
      screen.getByText("Your phone will ring first — this call will be logged to J00042."),
    ).toBeInTheDocument();
  });
});

// The WebRTC softphone dials CTM in the browser, bypassing the click-to-call
// bridge that writes the PendingCallAttribution stash — so it must POST that
// stash itself (POST /calls/attribution) BEFORE ringing, or a call placed from a
// job/lead lands as a bare CallSession with no job/lead link.
describe("Softphone WebRTC softphone attribution (E2 — office softphone path)", () => {
  const device = (): FakeDevice => ({
    call: vi.fn(),
    hangup: vi.fn(),
    mute: vi.fn(),
    ready: Promise.resolve(),
    awaitingStart: false,
  });

  it("stashes attribution (job_id + customer_id, defined keys only) BEFORE placing the WebRTC call — never the bridge", async () => {
    softphone.current = device();
    render(<Softphone prefillNumber="5555550199" entityContext={JOB_CONTEXT} />);

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    // The browser dials CTM directly — the click-to-call bridge is never used.
    expect(placeCall.mutate).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(stashAttribution.mutateAsync).toHaveBeenCalledTimes(1));
    expect(stashAttribution.mutateAsync).toHaveBeenCalledWith({
      to_number: "+15555550199",
      job_id: JOB_CONTEXT.jobId,
      customer_id: JOB_CONTEXT.customerId,
    });

    await vi.waitFor(() => expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199"));
    // The stash is committed before the device rings.
    const stashOrder = stashAttribution.mutateAsync.mock.invocationCallOrder[0]!;
    const callOrder = softphone.current!.call.mock.invocationCallOrder[0]!;
    expect(stashOrder).toBeLessThan(callOrder);
  });

  it("posts lead_id (only) for a lead context", async () => {
    softphone.current = device();
    render(
      <Softphone
        prefillNumber="5555550199"
        entityContext={{
          leadId: "e0000000-0000-0000-0000-000000000001",
          leadLabel: "L00007",
          customerId: "c0000000-0000-0000-0000-000000000001",
          customerName: "John Doe",
        }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() => expect(stashAttribution.mutateAsync).toHaveBeenCalledTimes(1));
    const body = stashAttribution.mutateAsync.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      to_number: "+15555550199",
      lead_id: "e0000000-0000-0000-0000-000000000001",
      customer_id: "c0000000-0000-0000-0000-000000000001",
    });
    expect(body).not.toHaveProperty("job_id");
  });

  it("pre-authorizes with to_number only when there is no entity context — the server allowlist gate sees EVERY dial", async () => {
    // O-0 (live QA 2026-07-21): the WebRTC device dials CTM directly from the
    // browser, so this POST is the only server checkpoint before a call rings.
    // A bare-number dial must hit it too, not just entity-context dials.
    softphone.current = device();
    render(<Softphone prefillNumber="5555550199" />);

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() => expect(stashAttribution.mutateAsync).toHaveBeenCalledTimes(1));
    expect(stashAttribution.mutateAsync).toHaveBeenCalledWith({ to_number: "+15555550199" });
    await vi.waitFor(() => expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199"));
    expect(placeCall.mutate).not.toHaveBeenCalled();
  });

  it("a 409 NOT_IN_TEST_ALLOWLIST BLOCKS the WebRTC dial and shows the allowlist copy", async () => {
    softphone.current = device();
    stashAttribution.mutateAsync.mockRejectedValueOnce({
      response: { status: 409, data: { code: "NOT_IN_TEST_ALLOWLIST" } },
    });
    render(<Softphone prefillNumber="6098745299" />);

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() => expect(stashAttribution.mutateAsync).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("This number isn't on the test allowlist (Phase-0 guard)"),
    ).toBeInTheDocument();
    // The device must never ring — the server refused this destination.
    expect(softphone.current!.call).not.toHaveBeenCalled();
    // Back in the idle state, ready for a corrected number.
    expect(screen.getByRole("button", { name: "Call" })).toBeInTheDocument();
  });

  it("still places the call when the stash fails for any non-allowlist reason (best-effort attribution)", async () => {
    softphone.current = device();
    stashAttribution.mutateAsync.mockRejectedValueOnce(new Error("stash 500"));
    render(<Softphone prefillNumber="5555550199" entityContext={JOB_CONTEXT} />);

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() => expect(stashAttribution.mutateAsync).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199"));
  });

  it("keeps the entity context when the number is edited — stashes the edited number", async () => {
    softphone.current = device();
    render(<Softphone prefillNumber="5555550199" entityContext={JOB_CONTEXT} />);

    // Redirecting to another number (e.g. an allowlisted test line) still
    // attributes the call to the job the dialer was opened from.
    await userEvent.type(screen.getByPlaceholderText("Enter a number"), "9");
    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    await vi.waitFor(() => expect(stashAttribution.mutateAsync).toHaveBeenCalledTimes(1));
    expect(stashAttribution.mutateAsync).toHaveBeenCalledWith({
      to_number: "+155555501999",
      job_id: JOB_CONTEXT.jobId,
      customer_id: JOB_CONTEXT.customerId,
    });
    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+155555501999"),
    );
  });
});
