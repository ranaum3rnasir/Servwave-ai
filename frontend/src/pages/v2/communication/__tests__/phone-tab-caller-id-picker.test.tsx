// Master plan Task B3 — the /phone tab's caller-ID picker: an optional
// per-call override, allow-list only (the user's own assigned numbers +
// the org default from Task B3's GET /api/communication/my-numbers — never
// free text, never another user's number). Default selection is the
// resolved primary number from Task B1/B2 (useMyOutboundNumber). Selecting
// a different allow-listed number changes what rides as dialFrom
// (officeSoftphone.call(e164, fromTpnId)) on the NEXT call.
//
// Retargeted at `pages/v2/communication/PhoneTabPage` when the legacy
// `pages/phone/PhoneShell` was deleted as unroutable. PhoneTabPage is the page
// `/phone` actually mounts, and its docblock records the picker as the one
// deliberate change from PhoneShell: a raw `<select>` became the kit Select,
// keeping the same accessible name ("Calling from") and the same option labels.
// So the ASSERTIONS move to the kit's shape - the trigger is a button with
// `role="combobox"`, and options exist in the DOM only while it is open - while
// every property being asserted is the same one.
//
// TWO THINGS THE MOVE EXPOSED, both fixed here rather than papered over:
//
//   - the `useMyOutboundNumber` mock did not reproduce the real hook's
//     `enabled = true` default, so a no-arg call (which is how the page calls
//     it) returned `data: undefined`. The seed effect therefore never ran, and
//     "defaults the selection to the resolved primary number" passed only
//     because a native <select> with value="" displays its FIRST option, which
//     happened to be the user default. Against the kit Select that shows an
//     empty trigger instead, so the artifact surfaced as a failure. The mock now
//     carries the same default as the hook and the seed genuinely runs.
//   - `expect(picker.tagName).toBe("SELECT")` was standing in for "caller ID is
//     a closed list, never free text". That claim is preserved directly below,
//     by the option count plus the absence of any textbox with this name.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/__tests__/helpers";
import { PHONE_TAB_NAME } from "@/lib/communication/phoneTabHandoff";

const placeCall = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const stashAttribution = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
  isPending: false,
}));

vi.mock("@/lib/api/communication", () => ({
  BUSINESS_NUMBER: "(551) 282-7064",
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useStashCallAttribution: () => stashAttribution,
  useCallOutcome: () => ({ data: null }),
  // PhoneTabPage hosts the full DialerWorkspace (search + softphone + panel),
  // so these are pulled in too. The picker test never searches, so an empty
  // search + empty call list keep the panel on its idle state.
  useCalls: () => ({ data: [] }),
  useDialerSearch: () => ({ data: undefined, isFetching: false }),
}));

type FakeDevice = {
  call: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  ready: boolean;
  awaitingStart: boolean;
};
const softphone = vi.hoisted(() => ({ current: null as null | FakeDevice }));

vi.mock("@/lib/communication/useCtmSoftphone", () => ({
  useCtmSoftphone: () => softphone.current,
}));

// Task B1/B2's resolved-default hook — the picker's default selection.
type Resolved =
  | { provider_number_id?: string; ctm_number_id?: string; phone_number_id: string; formatted: string | null }
  | { none: true };
const myOutboundNumber = vi.hoisted(() => ({ current: null as null | Resolved }));

// `enabled = true` mirrors the real hook's default. The page calls this with no
// argument, so without the default the mock answered `undefined` and the seed
// effect it is here to exercise never ran.
vi.mock("@/lib/api/myOutboundNumber", () => ({
  useMyOutboundNumber: vi.fn((enabled = true) => ({
    data: enabled ? myOutboundNumber.current : undefined,
  })),
}));

// Task B3's allow-list hook — the picker's option list. `phoneNumbers.ts`
// also exports admin-only assignment hooks (untouched here) — only
// `useMyNumbers` is mocked, so a picker that reached for the admin hook
// instead would fail loudly rather than silently pass.
type MyNumbers = { numbers: Array<{
  phone_number_id: string;
  provider_number_id?: string;
  ctm_number_id?: string;
  formatted: string | null;
  is_org_default: boolean;
  is_user_default: boolean;
}> };
const myNumbers = vi.hoisted(() => ({ current: { numbers: [] } as MyNumbers }));

vi.mock("@/lib/api/phoneNumbers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/phoneNumbers")>(
    "@/lib/api/phoneNumbers",
  );
  return {
    ...actual,
    useMyNumbers: vi.fn(() => ({ data: myNumbers.current })),
  };
});

import PhoneTabPage from "../PhoneTabPage";
import { useMyNumbers } from "@/lib/api/phoneNumbers";

const TPN_USER = "TPN_USER_DEFAULT";
const TPN_ORG = "TPN_ORG_DEFAULT";
const TPN_EXTRA = "TPN_EXTRA_ASSIGNED";

const USER_DEFAULT_OPTION = {
  phone_number_id: "pn_user",
  ctm_number_id: TPN_USER,
  formatted: "(609) 555-0100",
  is_org_default: false,
  is_user_default: true,
};
const ORG_DEFAULT_OPTION = {
  phone_number_id: "pn_org",
  ctm_number_id: TPN_ORG,
  formatted: "(551) 282-7064",
  is_org_default: true,
  is_user_default: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  softphone.current = { call: vi.fn(), hangup: vi.fn(), mute: vi.fn(), ready: true, awaitingStart: false };
  myOutboundNumber.current = {
    ctm_number_id: TPN_USER,
    phone_number_id: "pn_user",
    formatted: "(609) 555-0100",
  };
  myNumbers.current = { numbers: [USER_DEFAULT_OPTION, ORG_DEFAULT_OPTION] };
});

async function placeACall() {
  const input = screen.getByPlaceholderText("Enter a number");
  await userEvent.type(input, "5555550199");
  await userEvent.click(screen.getByRole("button", { name: "Call" }));
}

describe("/phone caller-ID picker (Task B3)", () => {
  it("lists ONLY the allow-listed numbers (assigned + org default) - a closed list, never free text", async () => {
    renderWithProviders(<PhoneTabPage />);

    // The kit Select keeps its options out of the DOM until it is opened, so
    // the list is read after a click rather than straight off the trigger.
    await userEvent.click(screen.getByRole("combobox", { name: /caller id|calling from/i }));

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(screen.getByRole("option", { name: /\(609\) 555-0100/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /\(551\) 282-7064/ })).toBeInTheDocument();

    // Never a free-text entry for caller ID: it is a closed picker, and the
    // option count above is the whole list. The two textboxes present are the
    // workspace's job/customer search and the dial-pad number field - neither
    // is the caller ID.
    expect(screen.getByPlaceholderText("Enter a number")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search a job #/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /caller id|calling from/i })).not.toBeInTheDocument();
  });

  it("defaults the selection to the resolved primary number (Task B1/B2)", () => {
    renderWithProviders(<PhoneTabPage />);

    // The trigger renders the SELECTED option's label, so the label is what
    // proves which number is active. Reading `.value` off it would not: the kit
    // trigger is a button, and a button has no value.
    expect(screen.getByRole("combobox", { name: /caller id|calling from/i }))
      .toHaveTextContent("(609) 555-0100");
  });

  it("passes the resolved default as dialFrom when the user places a call without switching", async () => {
    renderWithProviders(<PhoneTabPage />);

    await placeACall();

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199", TPN_USER),
    );
  });

  it("switching the picker changes what is passed as dialFrom on the NEXT call", async () => {
    renderWithProviders(<PhoneTabPage />);

    await userEvent.click(screen.getByRole("combobox", { name: /caller id|calling from/i }));
    await userEvent.click(screen.getByRole("option", { name: /\(551\) 282-7064/ }));

    await placeACall();

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199", TPN_ORG),
    );
    expect(softphone.current!.call).not.toHaveBeenCalledWith("+15555550199", TPN_USER);
  });

  it("a user with more than one number can pick a THIRD assigned number too (not just user-default/org-default)", async () => {
    myNumbers.current = {
      numbers: [
        ...myNumbers.current.numbers,
        {
          phone_number_id: "pn_extra",
          ctm_number_id: TPN_EXTRA,
          formatted: "(212) 555-0199",
          is_org_default: false,
          is_user_default: false,
        },
      ],
    };
    renderWithProviders(<PhoneTabPage />);

    await userEvent.click(screen.getByRole("combobox", { name: /caller id|calling from/i }));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await userEvent.click(screen.getByRole("option", { name: /\(212\) 555-0199/ }));

    await placeACall();

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199", TPN_EXTRA),
    );
  });

  it("a user with exactly ONE allow-listed number sees it read-only/default — no interactive picker", () => {
    myNumbers.current = { numbers: [USER_DEFAULT_OPTION] };

    renderWithProviders(<PhoneTabPage />);

    expect(screen.queryByRole("combobox", { name: /caller id|calling from/i })).not.toBeInTheDocument();
    // The single number is still shown, just not as a picker.
    expect(screen.getByText(/\(609\) 555-0100/)).toBeInTheDocument();
  });

  it("a user with exactly one number still dials from it (no picker needed to resolve dialFrom)", async () => {
    myNumbers.current = { numbers: [USER_DEFAULT_OPTION] };

    renderWithProviders(<PhoneTabPage />);
    await placeACall();

    await vi.waitFor(() =>
      expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199", TPN_USER),
    );
  });
});

// The phone service's own id for a number ("TPN…") is how a call is placed,
// never something a person sees. A number with no formatted label must not fall
// back to it: the page shows a neutral label instead. (The endpoint already
// sends the number itself as `formatted` whenever it has one.)
describe("/phone never shows the phone service's number id", () => {
  const TPN_UNLABELED = "TPN_NO_LABEL_7731";
  const UNLABELED_OPTION = {
    phone_number_id: "pn_unlabeled",
    ctm_number_id: TPN_UNLABELED,
    formatted: null,
    is_org_default: false,
    is_user_default: false,
  };

  it("labels an unformatted number neutrally in the picker, and the id is nowhere in the page", async () => {
    myNumbers.current = { numbers: [USER_DEFAULT_OPTION, UNLABELED_OPTION] };
    renderWithProviders(<PhoneTabPage />);

    await userEvent.click(screen.getByRole("combobox", { name: /calling from/i }));

    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("option", { name: "Unknown number" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TPN_UNLABELED);
    expect(document.body.innerHTML).not.toContain(TPN_UNLABELED);
  });

  it("labels an unformatted number neutrally once it is chosen", async () => {
    myNumbers.current = { numbers: [USER_DEFAULT_OPTION, UNLABELED_OPTION] };
    renderWithProviders(<PhoneTabPage />);

    await userEvent.click(screen.getByRole("combobox", { name: /calling from/i }));
    await userEvent.click(screen.getByRole("option", { name: "Unknown number" }));

    expect(screen.getByRole("combobox", { name: /calling from/i })).toHaveTextContent("Unknown number");
    expect(document.body.textContent).not.toContain(TPN_UNLABELED);
  });

  it("labels a sole unformatted number neutrally, never with its id", () => {
    myNumbers.current = { numbers: [UNLABELED_OPTION] };
    myOutboundNumber.current = { ctm_number_id: TPN_UNLABELED, phone_number_id: "pn_unlabeled", formatted: null };
    renderWithProviders(<PhoneTabPage />);

    expect(screen.getByText("Unknown number")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(TPN_UNLABELED);
    expect(document.body.innerHTML).not.toContain(TPN_UNLABELED);
  });

  // A blank label is no label: an empty or all-space `formatted` must read as
  // "Unknown number" too, never as an empty picker row or a blank box.
  it.each([
    ["an empty", ""],
    ["an all-space", "   "],
  ])("labels a number with %s formatted value neutrally, in the picker and alone", async (_kind, formatted) => {
    myNumbers.current = { numbers: [USER_DEFAULT_OPTION, { ...UNLABELED_OPTION, formatted }] };
    const { unmount } = renderWithProviders(<PhoneTabPage />);

    await userEvent.click(screen.getByRole("combobox", { name: /calling from/i }));
    expect(screen.getByRole("option", { name: "Unknown number" })).toBeInTheDocument();
    unmount();

    myNumbers.current = { numbers: [{ ...UNLABELED_OPTION, formatted }] };
    myOutboundNumber.current = { ctm_number_id: TPN_UNLABELED, phone_number_id: "pn_unlabeled", formatted };
    renderWithProviders(<PhoneTabPage />);
    expect(screen.getByText("Unknown number")).toBeInTheDocument();
  });
});

// The backend names the number's id `provider_number_id`; `ctm_number_id`
// still arrives for one release. Frontend and backend deploy minutes apart in
// no fixed order, so the picker must work against either shape alone.
describe("/phone caller-ID picker across the deploy window", () => {
  const only = (key: "provider_number_id" | "ctm_number_id") => {
    const strip = <T extends { ctm_number_id?: string; provider_number_id?: string }>(o: T) => {
      const id = o.provider_number_id ?? o.ctm_number_id;
      const { ctm_number_id: _c, provider_number_id: _p, ...rest } = o;
      void _c; void _p;
      return { ...rest, [key]: id };
    };
    myOutboundNumber.current = strip({ ctm_number_id: TPN_USER, phone_number_id: "pn_user", formatted: "(609) 555-0100" });
    myNumbers.current = { numbers: [strip(USER_DEFAULT_OPTION), strip(ORG_DEFAULT_OPTION)] };
  };

  it.each(["provider_number_id", "ctm_number_id"] as const)(
    "with only %s: defaults to the resolved number and dials from the picked one",
    async (key) => {
      only(key);
      renderWithProviders(<PhoneTabPage />);

      expect(screen.getByRole("combobox", { name: /calling from/i })).toHaveTextContent("(609) 555-0100");

      await userEvent.click(screen.getByRole("combobox", { name: /calling from/i }));
      await userEvent.click(screen.getByRole("option", { name: /\(551\) 282-7064/ }));
      await placeACall();

      await vi.waitFor(() =>
        expect(softphone.current!.call).toHaveBeenCalledWith("+15555550199", TPN_ORG),
      );
    },
  );
});

// A row the softphone cannot dial from (no phone-service id under either key)
// is not a caller-ID choice: it never becomes an option with an empty value,
// and it does not count toward "more than one number".
describe("/phone caller-ID picker skips rows with no phone-service id", () => {
  const NO_ID_ROW = {
    phone_number_id: "pn_no_id",
    formatted: "(732) 555-0142",
    is_org_default: false,
    is_user_default: false,
  };

  it("lists only the dialable numbers", async () => {
    myNumbers.current = { numbers: [USER_DEFAULT_OPTION, NO_ID_ROW, ORG_DEFAULT_OPTION] };
    renderWithProviders(<PhoneTabPage />);

    await userEvent.click(screen.getByRole("combobox", { name: /calling from/i }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByRole("option", { name: /\(732\) 555-0142/ })).not.toBeInTheDocument();
  });

  it("treats one dialable number plus an undialable row as a sole number, not a picker", () => {
    myNumbers.current = { numbers: [USER_DEFAULT_OPTION, NO_ID_ROW] };
    renderWithProviders(<PhoneTabPage />);

    expect(screen.queryByRole("combobox", { name: /calling from/i })).not.toBeInTheDocument();
    expect(screen.getByText("(609) 555-0100")).toBeInTheDocument();
    expect(screen.queryByText("(732) 555-0142")).not.toBeInTheDocument();
  });
});

// Sanity: the mocked hook is actually what the module under test imports —
// guards against a stale mock path silently no-op'ing (e.g. the picker
// reading a hook from a different module and this test passing for the
// wrong reason).
describe("useMyNumbers mock wiring sanity", () => {
  it("is the mocked fn PhoneTabPage/Softphone would call", () => {
    expect(vi.isMockFunction(useMyNumbers)).toBe(true);
  });
});

// A tab's `window.name` sticks across in-tab navigation (HTML spec), so once
// this tab is left via any route change, it must stop impersonating the
// PHONE_TAB_NAME handoff target — otherwise the next Call button clicked FROM
// this same tab would find `window.open(url, 'servwave-phone')` targeting its
// OWN name, which the spec resolves as an in-place navigation, not a new tab.
describe("browsing-context name cleanup on unmount", () => {
  afterEach(() => {
    window.name = "";
  });

  it("resets window.name when this tab was the PHONE_TAB_NAME target", () => {
    window.name = PHONE_TAB_NAME;
    const { unmount } = renderWithProviders(<PhoneTabPage />);

    unmount();

    expect(window.name).toBe("");
  });

  it("leaves an unrelated window.name untouched", () => {
    window.name = "some-other-window";
    const { unmount } = renderWithProviders(<PhoneTabPage />);

    unmount();

    expect(window.name).toBe("some-other-window");
  });
});
