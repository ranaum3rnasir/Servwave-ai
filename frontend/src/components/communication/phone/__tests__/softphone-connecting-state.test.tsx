// Fix B — the softphone's honest "Connecting…" loading state. While the
// shared office device (useCtmSoftphone's handle) is non-null but not yet
// ready, the status pill reads "Connecting…" instead of "Ready" and the Call
// button is disabled — so a user can't press Call into a device that hasn't
// finished booting. The bridge/tel path (officeSoftphone === null) must be
// byte-for-byte unchanged; that path is exercised by the existing
// softphone-entity-context suite (which never sets a device), and re-asserted
// here as a baseline.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const placeCall = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
}));

vi.mock('@/lib/api/communication', () => ({
  BUSINESS_NUMBER: '(551) 282-7064',
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => placeCall,
  useCallOutcome: () => ({ data: null }),
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
    isPending: false,
  }),
}));

// Task B2 — the resolved caller-ID fetch is out of scope for this suite;
// stub it to no data so the office-softphone `call()` assertions below stay
// on their pre-B2 single-argument shape (covered separately by
// softphone-dialfrom.test.tsx).
vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

type FakeDevice = {
  ready: boolean;
  awaitingStart: boolean;
  /** Slice 3 — why it is not ready, once that is knowable. Optional so every
   *  pre-existing case in this file keeps its original shape. */
  fault?: SoftphoneFault | null;
  call: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
};
// null by default (bridge/tel path) — a test sets it to a fake handle to
// exercise the office-softphone path.
const softphone = vi.hoisted(() => ({ current: null as null | FakeDevice }));

vi.mock('@/lib/communication/useCtmSoftphone', () => ({
  useCtmSoftphone: () => softphone.current,
}));

import type { SoftphoneFault } from '@/lib/communication/ctmSoftphone';
import { Softphone } from '../Softphone';

beforeEach(() => {
  vi.clearAllMocks();
  softphone.current = null;
});

describe('Softphone — Connecting state (Fix B)', () => {
  it('reads "Ready" on the bridge/tel path (officeSoftphone null) — unchanged', () => {
    render(<Softphone />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });

  it('reads "Connecting…" and disables Call while the shared device is still booting', () => {
    softphone.current = { ready: false, awaitingStart: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550199" />);

    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
  });

  it('reads "Ready" and enables Call once the shared device finishes booting', () => {
    softphone.current = { ready: true, awaitingStart: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550199" />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call' })).not.toBeDisabled();
  });

  it('still disables Call with no dial value even once ready (pre-existing rule, untouched)', () => {
    softphone.current = { ready: true, awaitingStart: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone />);
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
  });

  // The disabled Call button only blocks a mouse click on it — three other
  // paths call startOutbound()/reach sp.call() directly: autoCallNumber ("Call
  // back" from a call detail drawer), the global Enter keydown handler, and
  // the dial input's own Enter keydown. All three must respect the same
  // readiness guard as the button, or a user can place a call on a device
  // that hasn't finished booting (no auth token set yet).
  it('does not place a call via autoCallNumber while the shared device is still booting', () => {
    softphone.current = { ready: false, awaitingStart: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone autoCallNumber="5555550199" />);

    expect(softphone.current!.call).not.toHaveBeenCalled();
    // The guard returns before any state transition — still "Connecting…",
    // never "Calling…".
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText('Calling…')).not.toBeInTheDocument();
  });

  it('does not place a call via the global Enter keydown handler while still booting', () => {
    softphone.current = { ready: false, awaitingStart: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550199" />);

    // Move focus off the dial input so the WINDOW-level Enter handler runs
    // instead of the input's own onKeyDown (covered separately below).
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(softphone.current!.call).not.toHaveBeenCalled();
  });

  it("does not place a call via the dial input's own Enter keydown while still booting", () => {
    softphone.current = { ready: false, awaitingStart: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone />);

    const input = screen.getByPlaceholderText('Enter a number');
    fireEvent.change(input, { target: { value: '5555550199' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(softphone.current!.call).not.toHaveBeenCalled();
  });

  it('places the call via autoCallNumber once the shared device is ready (happy path — now behind the server pre-dial gate)', async () => {
    softphone.current = { ready: true, awaitingStart: false, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone autoCallNumber="5555550199" />);

    // The dial awaits the /calls/attribution authorize round-trip (O-0 gate),
    // so it lands a microtask after render rather than synchronously.
    await vi.waitFor(() => expect(softphone.current!.call).toHaveBeenCalledWith('+15555550199'));
  });
});

// Slice 3 — a device can fail to boot for several distinct reasons, and all of
// them used to render as the same eternal "Connecting…": honest about not being
// ready, silent about why, and with no way to ever stop saying it. The pill now
// says which one, in ServWave's own words (the naming boundary in CLAUDE.md
// means the telephony vendor is never named in anything a user can see).
describe('Softphone — device fault (slice 3)', () => {
  const CASES: [SoftphoneFault, string][] = [
    ['locked-out', 'Phone active in another tab'],
    ['station-check', 'Audio check required'],
    ['unknown', 'Phone unavailable — reload to retry'],
  ];

  it.each(CASES)('renders its own sentence for %s, in place of "Connecting…"', (fault, text) => {
    softphone.current = { ready: false, awaitingStart: false, fault, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550199" />);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it.each(CASES)('keeps the Call button disabled under %s', (fault) => {
    softphone.current = { ready: false, awaitingStart: false, fault, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550199" />);

    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
  });

  // The defence-in-depth half of `softphoneBlocked`. officeSoftphone.ts already
  // guarantees ready and fault are never both set, so this handle cannot occur
  // in production today — the case exists so that if that invariant is ever
  // broken two modules away, the dialer refuses rather than offering a live-
  // looking Call button under a pill saying the phone is unavailable.
  it('refuses to dial a handle that claims ready AND a fault at once', () => {
    softphone.current = {
      ready: true, awaitingStart: false,
      fault: 'locked-out',
      call: vi.fn(),
      mute: vi.fn(),
      hangup: vi.fn(),
    };
    render(<Softphone prefillNumber="5555550199" />);

    expect(screen.getByText('Phone active in another tab')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
  });

  it('does not place a call via autoCallNumber under a fault', () => {
    softphone.current = {
      ready: false, awaitingStart: false,
      fault: 'locked-out',
      call: vi.fn(),
      mute: vi.fn(),
      hangup: vi.fn(),
    };
    render(<Softphone autoCallNumber="5555550199" />);

    expect(softphone.current!.call).not.toHaveBeenCalled();
    expect(screen.queryByText('Calling…')).not.toBeInTheDocument();
  });

  // The normal pre-ready window is untouched: a fault REPLACES "Connecting…"
  // only once one exists, it does not pre-empt it.
  it('still reads "Connecting…" while the device is merely booting (fault null)', () => {
    softphone.current = { ready: false, awaitingStart: false, fault: null, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550199" />);

    expect(screen.getByText('Connecting…')).toBeInTheDocument();
  });

  it('reads "Ready" once the device boots, with no fault to report', () => {
    softphone.current = { ready: true, awaitingStart: false, fault: null, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    render(<Softphone prefillNumber="5555550199" />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call' })).not.toBeDisabled();
  });
});
