/**
 * RecordEstimatePaymentDialog - the deposit %/amount pair.
 *
 * Two defects this guards, both visible in the shipped dialog:
 *   1. The amount was `String((total * pct) / 100)` with no rounding, so a 70% deposit on $106.63
 *      rendered "74.64099999999999" in the input and posted that float as the payment.
 *   2. `amountTouched` was a permanent one-way latch: % -> amount stopped after the first manual
 *      amount edit and amount -> % never happened at all, so the two fields could describe
 *      different deposits while BOTH were posted (`amount` + `deposit_percentage`).
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { RecordEstimatePaymentDialog } from '@/components/estimates/RecordEstimatePaymentDialog';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));

const mockOrg = vi.fn();
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => mockOrg(),
}));

const TOTAL = 106.63;

function renderDialog(props: Partial<React.ComponentProps<typeof RecordEstimatePaymentDialog>> = {}) {
  return renderWithProviders(
    <RecordEstimatePaymentDialog
      open
      onOpenChange={() => {}}
      estimateId="est-1"
      estimateNumber="J00229-2"
      totalAmount={TOTAL}
      {...props}
    />,
  );
}

const pctInput = () => screen.getByLabelText(/deposit %/i) as HTMLInputElement;
const amtInput = () => screen.getByLabelText(/deposit amount/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  // Org default 50% - deliberately different from the estimate override below, so a test that
  // passes on org defaults alone cannot also pass on the override.
  mockOrg.mockReturnValue({
    data: { deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 },
  });
  (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });
});

describe('deposit defaults', () => {
  it('rounds the prefilled amount to cents', () => {
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });
    expect(pctInput().value).toBe('70');
    expect(amtInput().value).toBe('74.64'); // was 74.64099999999999
  });

  it('prefers the estimate deposit override over the org default', () => {
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });
    expect(pctInput().value).toBe('70'); // not the org's 50
  });

  it('falls back to the org default when the estimate has no override', () => {
    renderDialog();
    expect(pctInput().value).toBe('50');
    expect(amtInput().value).toBe('53.32');
  });

  it('lets a frozen send_config outrank both', () => {
    renderDialog({
      depositType: 'PERCENTAGE',
      depositValue: 70,
      existingDepositPercentage: 25,
      existingDepositAmount: 26.66,
    });
    expect(pctInput().value).toBe('25');
    expect(amtInput().value).toBe('26.66');
  });
});

describe('two-way %/amount binding', () => {
  it('updates the amount when the percentage changes', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(pctInput());
    await user.type(pctInput(), '50');

    expect(amtInput().value).toBe('53.32');
  });

  it('updates the percentage when the amount changes', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(amtInput());
    await user.type(amtInput(), '40');

    // 40 / 106.63 * 100, rounded to 2dp for legibility (see percentFromAmount).
    expect(pctInput().value).toBe('37.51');
  });

  it('keeps mirroring after the amount has been edited once', async () => {
    // The regression: `amountTouched` latched true here and the % never drove the amount again.
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(amtInput());
    await user.type(amtInput(), '40');
    await user.clear(pctInput());
    await user.type(pctInput(), '25');

    expect(amtInput().value).toBe('26.66');
  });

  it('posts an amount and a percentage that describe the same deposit', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(amtInput());
    await user.type(amtInput(), '40');
    await user.click(screen.getByRole('button', { name: /record payment/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = (api.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(body.amount).toBe(40);
    expect((TOTAL * body.deposit_percentage) / 100).toBeCloseTo(40, 2);
  });
});

/**
 * `payments.paid_at` is a true INSTANT: 3,182 of the 3,219 rows on staging are real
 * timestamps written by Stripe webhooks or the server's own `new Date()`. This dialog
 * was the one live writer of the other kind - it posted `new Date('2026-08-04')`,
 * which parses as UTC MIDNIGHT and is therefore the previous evening in every US
 * timezone, so the payment rendered a day early on any local-time surface.
 *
 * The timezone is pinned rather than inherited: under an ambient TZ of UTC (what CI
 * runs) the buggy code passes every one of these assertions, and the guard would be
 * vacuous. Node re-reads process.env.TZ on mutation, so this is enough to fix it.
 */
describe('paid_at is a true instant, not a UTC-midnight artifact', () => {
  const realTZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = realTZ;
    vi.useRealTimers();
  });

  const dateInput = () => screen.getByLabelText(/date received/i) as HTMLInputElement;
  /**
   * The field is a typeable `DatePicker`, not a native `<input type="date">`: it
   * holds pattern-formatted TEXT (US MM/DD/YYYY by default) and only commits the
   * parsed 'YYYY-MM-DD' upward on blur or Enter. Typing alone leaves the parent's
   * value untouched, so a bare `fireEvent.change` silently posts today instead of
   * the day under test. Real users blur the field by clicking Record Payment;
   * these tests have to do the same explicitly.
   */
  const setDate = (display: string) => {
    fireEvent.change(dateInput(), { target: { value: display } });
    fireEvent.blur(dateInput());
  };
  const postedBody = () => (api.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
  /** The calendar day a local-time renderer would show for a posted instant. */
  const localDay = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  it('defaults to the LOCAL calendar day, not the UTC one', () => {
    // 23:30 on Aug 4 in New York is already Aug 5 in UTC. `toISOString().slice(0,10)`
    // opened the picker on tomorrow for every evening payment.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-05T03:30:00.000Z'));

    renderDialog();

    expect(dateInput().value).toBe('08/04/2026');
  });

  it('posts an instant that still reads as the selected day in local time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-04T14:00:00.000Z'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDialog();

    // A back-dated deposit: the day is known, the time of day is not.
    setDate('07/15/2026');
    await user.click(screen.getByRole('button', { name: /record payment/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const paidAt = postedBody().paid_at as string;

    expect(paidAt).not.toBe('2026-07-15T00:00:00.000Z');
    expect(localDay(paidAt)).toBe('2026-07-15');
  });

  it('back-dates to local noon, which no DST shift can move onto another day', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-04T14:00:00.000Z'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDialog();

    // 2026-11-01 is the US DST fall-back day - the worst case for a start-of-day stamp.
    setDate('11/01/2026');
    await user.click(screen.getByRole('button', { name: /record payment/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const paidAt = postedBody().paid_at as string;

    expect(localDay(paidAt)).toBe('2026-11-01');
    expect(new Date(paidAt).getHours()).toBe(12);
  });

  it('keeps the real clock time when the payment is being recorded today', async () => {
    // Today has a knowable time of day, so it is recorded rather than invented.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-05T03:30:00.000Z'));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderDialog();

    await user.click(screen.getByRole('button', { name: /record payment/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const paidAt = postedBody().paid_at as string;

    expect(paidAt).toBe('2026-08-05T03:30:00.000Z');
    expect(localDay(paidAt)).toBe('2026-08-04');
  });
});

describe('edge cases', () => {
  it('leaves a cleared field empty instead of writing NaN into the other one', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(pctInput());
    // Clearing must not mirror: an unparseable field leaves its partner alone rather than
    // stamping NaN into it (and the empty box stays empty, so it is still typable).
    expect(pctInput().value).toBe('');
    expect(amtInput().value).toBe('74.64');

    await user.type(pctInput(), '7');
    expect(amtInput().value).toBe('7.46');
  });

  it('does not produce NaN on a zero-total estimate', () => {
    renderDialog({ totalAmount: 0, depositType: 'PERCENTAGE', depositValue: 70 });
    expect(pctInput().value).toBe('0');
    expect(amtInput().value).toBe('0');
  });

  it('omits a non-positive deposit_percentage rather than posting a 400', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    // A payment larger than the estimate total: the derived % exceeds the server's max(100).
    await user.clear(amtInput());
    await user.type(amtInput(), '200');
    await user.click(screen.getByRole('button', { name: /record payment/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = (api.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(body.amount).toBe(200);
    expect(body).not.toHaveProperty('deposit_percentage');
  });
});
