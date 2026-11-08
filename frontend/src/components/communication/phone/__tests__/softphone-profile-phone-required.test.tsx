// Mobile slice 21 - when the server refuses a bridge call because the caller has
// no usable profile phone (code PROFILE_PHONE_REQUIRED), the dialer shows the
// server's plain copy with a working link to My Profile (through the settings
// unsaved-changes guard), and does NOT retry the POST. Uses the REAL
// usePlaceCall (only the HTTP client is mocked) under a QueryClient whose
// mutation default is retry: 1, so it is the hook's own retry: false that keeps
// the POST count at one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const http = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/axios", () => ({ default: http }));
vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));
// Bridge path: no in-browser phone device.
vi.mock("@/lib/communication/useCtmSoftphone", () => ({
  useCtmSoftphone: () => null,
}));

import { Softphone } from "../Softphone";
import { useSettingsGuard } from "@/stores/settingsGuard.store";

const PROFILE_COPY = "Add your phone number to your profile to place calls from your phone";
const EXTENSION_COPY =
  "Your profile phone has an extension, which can't ring first. Add a direct number to your profile to place calls from your phone";

function refuseWith(data: Record<string, unknown>) {
  http.post.mockRejectedValue(Object.assign(new Error("Request failed"), { response: { status: 409, data } }));
}

function renderDialer() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 1, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/phone"]}>
        <Routes>
          <Route path="/phone" element={<Softphone prefillNumber="5551234567" />} />
          <Route path="/settings/profile" element={<h1>My Profile page</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const callPosts = () => http.post.mock.calls.filter(([url]) => url === "/api/communication/calls");

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  http.get.mockResolvedValue({ data: { contacts: [] } });
});

describe("Softphone - profile phone required (bridge refusal)", () => {
  it("shows the server copy with a link to My Profile, and posts exactly once", async () => {
    refuseWith({ code: "PROFILE_PHONE_REQUIRED", reason: "missing", error: PROFILE_COPY });
    renderDialer();

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(await screen.findByText(PROFILE_COPY)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /go to my profile/i });
    expect(link).toHaveAttribute("href", "/settings/profile");
    // The error only renders once every retry has run, so one POST here means
    // none was retried (the client default above would retry once).
    expect(callPosts()).toHaveLength(1);

    // The link actually goes there.
    await userEvent.click(link);
    expect(await screen.findByRole("heading", { name: "My Profile page" })).toBeInTheDocument();
  });

  it("with unsaved settings edits, the link asks the settings guard first and only leaves on confirm", async () => {
    refuseWith({ code: "PROFILE_PHONE_REQUIRED", reason: "missing", error: PROFILE_COPY });
    useSettingsGuard.setState({ isDirty: true, pendingLeave: null });
    renderDialer();

    await userEvent.click(screen.getByRole("button", { name: "Call" }));
    await userEvent.click(await screen.findByRole("link", { name: /go to my profile/i }));

    // Held: still on the dialer, a leave is pending for the confirm dialog.
    expect(screen.queryByRole("heading", { name: "My Profile page" })).not.toBeInTheDocument();
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();

    act(() => useSettingsGuard.getState().resolvePending());
    expect(await screen.findByRole("heading", { name: "My Profile page" })).toBeInTheDocument();
  });

  it("shows the invalid-number copy (server's words) with the profile link", async () => {
    const copy =
      "Your profile phone isn't a number we can ring. Update it in your profile to place calls from your phone";
    refuseWith({ code: "PROFILE_PHONE_REQUIRED", reason: "invalid", error: copy });
    renderDialer();

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to my profile/i })).toHaveAttribute("href", "/settings/profile");
  });

  it("calling your own profile phone shows the server copy, no profile link", async () => {
    refuseWith({ code: "CALLER_IS_CUSTOMER", error: "You can't call your own profile phone" });
    renderDialer();

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(await screen.findByText("You can't call your own profile phone")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /go to my profile/i })).not.toBeInTheDocument();
  });

  it.each([
    ["PROFILE_PHONE_REQUIRED", "Add your phone number to your profile to place calls from your phone", true],
    ["PHONE_CALLING_NOT_SET_UP", "Calling from your phone isn't set up for your account yet. Contact ServWave support", false],
    ["CALLER_IS_CUSTOMER", "You can't call your own profile phone", false],
  ])("%s without server copy falls back to its OWN text", async (code, fallback, link) => {
    refuseWith({ code });
    renderDialer();

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(await screen.findByText(fallback)).toBeInTheDocument();
    expect(!!screen.queryByRole("link", { name: /go to my profile/i })).toBe(link);
  });

  it("shows the extension copy (server's words) with the same link", async () => {
    refuseWith({ code: "PROFILE_PHONE_REQUIRED", reason: "extension", error: EXTENSION_COPY });
    renderDialer();

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(await screen.findByText(EXTENSION_COPY)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to my profile/i })).toHaveAttribute("href", "/settings/profile");
  });

  it("other errors keep today's copy and show no profile link", async () => {
    refuseWith({ error: "The phone system could not place the call" });
    renderDialer();

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(await screen.findByText("Couldn't place the call — try again")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /go to my profile/i })).not.toBeInTheDocument();
  });

  it("not-set-up refusal shows the server's plain copy, no profile link", async () => {
    const copy = "Calling from your phone isn't set up for your account yet. Contact ServWave support";
    refuseWith({ code: "PHONE_CALLING_NOT_SET_UP", error: copy });
    renderDialer();

    await userEvent.click(screen.getByRole("button", { name: "Call" }));

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /go to my profile/i })).not.toBeInTheDocument();
  });
});
