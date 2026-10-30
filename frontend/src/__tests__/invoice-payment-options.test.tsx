/**
 * Payments go-live slice 21 - "Payment options" on one invoice.
 *
 * Office users override which methods one invoice offers and whether it takes partial payments.
 * The card shows the org default until the invoice differs from it, says so when it does
 * ("Org default: Card and bank"), and "Use org default" puts the invoice back on the org's
 * defaults. Saves go through PATCH /api/invoices/:id, the same route the backend tests pin.
 */
import { describe, it, expect, vi, beforeEach, onTestFinished, beforeAll, afterAll } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { notifyManager, useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import type { PaymentMethod } from '@/types/entities';
import { renderWithProviders } from './helpers';
import { InvoicePaymentOptionsCard } from '@/components/invoices/InvoicePaymentOptionsCard';
import { SendInvoiceDialog } from '@/components/invoices/SendInvoiceDialog';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() },
}));

const patch = api.patch as ReturnType<typeof vi.fn>;
const get = api.get as ReturnType<typeof vi.fn>;

/** An org that can take card and bank payments and also takes checks by hand. */
const ORG = {
  accepted_payment_methods: ['CHECK', 'CARD', 'ACH'] as const,
  stripe_charges_enabled: true,
  card_offered_by_default: true,
  bank_offered_by_default: true,
};

type CardProps = React.ComponentProps<typeof InvoicePaymentOptionsCard>;

function renderCard(props: Partial<CardProps> = {}) {
  return renderWithProviders(
    <InvoicePaymentOptionsCard
      invoiceId="inv-1"
      paymentMethodsOverride={null}
      allowPartialPayment={null}
      org={{ ...ORG, accepted_payment_methods: [...ORG.accepted_payment_methods] }}
      canEdit
      {...props}
    />,
  );
}

const method = (name: RegExp) => screen.getByRole('checkbox', { name });

/** Signs in an admin whose org's plan lacks online payments, for this test only. */
function signedInWithoutOnlinePayments() {
  const signedIn = vi.mocked(useAuthStore).getMockImplementation()!;
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id: 'u1', role: 'ADMIN', org_features: ['payments', 'invoices'] }, isAuthenticated: true })) as never);
  onTestFinished(() => { vi.mocked(useAuthStore).mockImplementation(signedIn); });
}

beforeEach(() => {
  vi.clearAllMocks();
  patch.mockResolvedValue({ data: {} });
});

describe('Payment options copy (W3)', () => {
  it('shows no description under the title and no helper under the partial payments switch', () => {
    renderCard();
    expect(screen.queryByText('How the customer can pay this invoice.')).not.toBeInTheDocument();
    expect(screen.queryByText(/pay part of the balance now/)).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /allow partial payments/i })).toBeInTheDocument();
  });
});

describe('Payment options on a deposit invoice', () => {
  it('shows no partial payments switch: a deposit is always paid in full', () => {
    renderCard({ isDeposit: true, allowPartialPayment: true });
    expect(screen.getByText('Payment options')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /allow partial payments/i })).not.toBeInTheDocument();
  });
});

describe('Payment options on one invoice', () => {
  it('follows the org default until changed: every default method offered, partial payments off', () => {
    renderCard();
    expect(screen.getByText('Payment options')).toBeInTheDocument();
    expect(method(/^card$/i)).toBeChecked();
    expect(method(/^bank$/i)).toBeChecked();
    expect(method(/^check$/i)).toBeChecked();
    expect(screen.getByRole('switch', { name: /allow partial payments/i })).not.toBeChecked();
    expect(screen.queryByText(/org default:/i)).not.toBeInTheDocument();
  });

  it('makes the invoice bank-only and saves that list for this invoice', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(method(/^card$/i));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/invoices/inv-1', { payment_methods_override: ['ACH', 'CHECK'] }));

    await user.click(method(/^check$/i));
    await waitFor(() => expect(patch).toHaveBeenLastCalledWith('/api/invoices/inv-1', { payment_methods_override: ['ACH'] }));
  });

  it('says how an overridden invoice differs from the org default', () => {
    renderCard({ paymentMethodsOverride: ['ACH'], allowPartialPayment: true });
    expect(method(/^card$/i)).not.toBeChecked();
    expect(method(/^bank$/i)).toBeChecked();
    expect(method(/^check$/i)).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /allow partial payments/i })).toBeChecked();
    expect(screen.getByText('Org default: Card, bank and check')).toBeInTheDocument();
    expect(screen.getByText('Org default: off')).toBeInTheDocument();
  });

  it('an override that lists exactly the org default reads as the org default', () => {
    renderCard({ paymentMethodsOverride: ['CHECK', 'ACH', 'CARD'] });
    expect(screen.queryByText(/org default:/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use org default/i })).not.toBeInTheDocument();
  });

  it('"Use org default" resets the invoice, and it then reads as the org default again', async () => {
    const user = userEvent.setup();
    const { rerender } = renderCard({ paymentMethodsOverride: ['ACH'], allowPartialPayment: true });

    await user.click(screen.getByRole('button', { name: /use org default/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/invoices/inv-1', {
      payment_methods_override: null, allow_partial_payment: null,
    }));

    // The page refetches the invoice; it now carries no override.
    rerender(
      <InvoicePaymentOptionsCard
        invoiceId="inv-1"
        paymentMethodsOverride={null}
        allowPartialPayment={null}
        org={{ ...ORG, accepted_payment_methods: [...ORG.accepted_payment_methods] }}
        canEdit
      />,
    );
    expect(method(/^card$/i)).toBeChecked();
    expect(method(/^check$/i)).toBeChecked();
    expect(screen.getByRole('switch', { name: /allow partial payments/i })).not.toBeChecked();
    expect(screen.queryByText(/org default:/i)).not.toBeInTheDocument();
  });

  it('switching every method back on returns the invoice to the org default instead of saving a copy', async () => {
    const user = userEvent.setup();
    renderCard({ paymentMethodsOverride: ['ACH', 'CHECK'] });
    await user.click(method(/^card$/i));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/invoices/inv-1', { payment_methods_override: null }));
  });

  it('turning partial payments off saves the org default (off), not a stored false', async () => {
    const user = userEvent.setup();
    renderCard({ allowPartialPayment: true });
    await user.click(screen.getByRole('switch', { name: /allow partial payments/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/invoices/inv-1', { allow_partial_payment: null }));
  });

  it('keeps the last method: an invoice cannot be left with no way to pay', async () => {
    const user = userEvent.setup();
    renderCard({ paymentMethodsOverride: ['ACH'] });
    await user.click(method(/^bank$/i));
    expect(method(/^bank$/i)).toBeChecked();
    expect(screen.getByText('Keep at least one method, or use the org default.')).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it('shows an online method the account cannot take yet as unavailable, and still lets it be chosen', async () => {
    const user = userEvent.setup();
    renderCard({ org: { accepted_payment_methods: ['CHECK', 'CARD'], stripe_charges_enabled: true } });
    expect(screen.getByText('Unavailable until bank payments are active')).toBeInTheDocument();
    expect(screen.queryByText('Unavailable until card payments are active')).not.toBeInTheDocument();
    expect(method(/^bank$/i)).not.toBeChecked();

    await user.click(method(/^bank$/i));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/invoices/inv-1', { payment_methods_override: ['CARD', 'ACH', 'CHECK'] }));
  });

  // Payments go-live slice 16 (fix round 2) - the customer's page offers no online method while the
  // org's plan lacks online payments, so this card must not show Card or Bank as offered.
  it('an org whose plan lacks online payments: Card and Bank read unoffered and say why', () => {
    signedInWithoutOnlinePayments();
    renderCard();

    expect(method(/^card$/i)).not.toBeChecked();
    expect(method(/^bank$/i)).not.toBeChecked();
    expect(method(/check/i)).toBeChecked();
    expect(screen.getAllByText('Not included in your plan.')).toHaveLength(2);
    expect(screen.queryByText(/^Unavailable until/)).not.toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  // Slice 25 (slice 21 review item 1): the customer's page offers an online method only while the
  // account can take it, so a list holding nothing else leaves the customer no way to pay.
  it('warns when the invoice offers only online methods the account cannot take, until one can be used', async () => {
    const user = userEvent.setup();
    renderCard({
      paymentMethodsOverride: ['CARD'],
      org: { accepted_payment_methods: ['CHECK', 'CARD'], stripe_charges_enabled: false },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The customer has no way to pay this invoice yet. Add a method recorded by hand or use the org default.',
    );

    await user.click(method(/^check$/i));
    expect(screen.queryByText(/no way to pay/i)).not.toBeInTheDocument();
  });

  // Slice 25 (slice 21 review item 2): the customer's page offers every manual method the invoice
  // lists, even one the org has since stopped accepting, so staff must see it here too.
  it('shows a stored manual method the org no longer accepts, and unticking it saves the list without it', async () => {
    const user = userEvent.setup();
    renderCard({ paymentMethodsOverride: ['ACH', 'ZELLE'] });
    expect(method(/^zelle$/i)).toBeChecked();
    expect(screen.getByText('Your org no longer accepts this')).toBeInTheDocument();

    await user.click(method(/^zelle$/i));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/invoices/inv-1', { payment_methods_override: ['ACH'] }));
  });

  it('is read-only for a user who cannot edit the invoice', () => {
    renderCard({ canEdit: false, paymentMethodsOverride: ['ACH'] });
    expect(method(/^bank$/i)).toBeDisabled();
    expect(screen.getByRole('switch', { name: /allow partial payments/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /use org default/i })).not.toBeInTheDocument();
    // The difference is still shown.
    expect(screen.getByText('Org default: Card, bank and check')).toBeInTheDocument();
  });

  it('names no payment processor', () => {
    const { container } = renderCard({ org: { accepted_payment_methods: ['CHECK'], stripe_charges_enabled: false } });
    expect(container.textContent).not.toMatch(/stripe/i);
  });
});

/**
 * Staging acceptance F1: boxes clicked about 0.4 s apart or faster lost edits. Every save refetches
 * the invoice, and a refetch that landed after the next click put the older stored list back on
 * screen; the click after that then saved a list built on it. These tests run the card the way the
 * invoice page does (the invoice comes from the ['invoice', id] query) against a server that only
 * answers when the test says so, so a slow refetch or a late save can land at any point.
 */
type Pending = { kind: 'patch' | 'get'; answer: () => void; fail?: () => void };

function slowServer(initial: { methods: PaymentMethod[] | null; partial: boolean | null }) {
  const stored = { ...initial };
  const queue: Pending[] = [];
  patch.mockImplementation((_url: string, body: Record<string, unknown>) =>
    new Promise((resolve, reject) => {
      queue.push({
        kind: 'patch',
        answer: () => {
          if ('payment_methods_override' in body) stored.methods = body.payment_methods_override as PaymentMethod[] | null;
          if ('allow_partial_payment' in body) stored.partial = body.allow_partial_payment as boolean | null;
          resolve({ data: {} });
        },
        // The server refuses the save and stores nothing.
        fail: () => reject(new Error('Request failed with status code 500')),
      });
    }));
  get.mockImplementation(() => {
    // The server reads the invoice when the request arrives; only the answer is slow.
    const snapshot = { payment_methods_override: stored.methods, allow_partial_payment: stored.partial };
    return new Promise((resolve) => {
      queue.push({ kind: 'get', answer: () => resolve({ data: { invoice: snapshot } }) });
    });
  });

  const answerAt = async (index: number) => {
    const [next] = queue.splice(index, 1);
    await act(async () => { next.answer(); });
  };
  return {
    stored,
    pending: (kind: Pending['kind']) => queue.filter((p) => p.kind === kind).length,
    /** Answer the oldest request of this kind. */
    answer: (kind: Pending['kind']) => answerAt(queue.findIndex((p) => p.kind === kind)),
    /** Refuse the oldest save: nothing is stored. */
    fail: async () => {
      const [next] = queue.splice(queue.findIndex((p) => p.kind === 'patch'), 1);
      await act(async () => { next.fail!(); });
    },
    /** Answer the newest request of this kind first, as a busy server might. */
    answerNewest: (kind: Pending['kind']) => answerAt(queue.map((p) => p.kind).lastIndexOf(kind)),
    /** Answer everything, oldest first, until nothing is left in flight. */
    settle: async () => {
      while (queue.length > 0) await answerAt(0);
    },
  };
}

/** The card as the invoice page mounts it: fed from the invoice query that every save refetches. */
function InvoicePage({ org, cards = 1 }: { org: CardProps['org']; cards?: number }) {
  const { data } = useQuery({
    queryKey: ['invoice', 'inv-1'],
    queryFn: async () => (await api.get('/api/invoices/inv-1')).data.invoice as {
      payment_methods_override: PaymentMethod[] | null;
      allow_partial_payment: boolean | null;
    },
  });
  if (!data) return null;
  // The detail page and its always-mounted send sheet each hold a card for the same invoice.
  return (
    <>
      {Array.from({ length: cards }, (_, i) => (
        <InvoicePaymentOptionsCard
          key={i}
          invoiceId="inv-1"
          paymentMethodsOverride={data.payment_methods_override}
          allowPartialPayment={data.allow_partial_payment}
          org={org}
          canEdit
        />
      ))}
    </>
  );
}

/** Card, bank, check and cash, all offered by default. */
const FOUR_METHODS = {
  accepted_payment_methods: ['CHECK', 'CASH', 'CARD', 'ACH'] as PaymentMethod[],
  stripe_charges_enabled: true,
  card_offered_by_default: true,
  bank_offered_by_default: true,
};

async function openInvoicePage(server: ReturnType<typeof slowServer>) {
  renderWithProviders(<InvoicePage org={FOUR_METHODS} />);
  await server.answer('get');
  await screen.findByText('Payment options');
}

describe('Payment options under fast clicks (F1)', () => {
  // The query cache normally tells React on a zero-delay timer; tell it at once, so a refetch
  // answered by the test is on screen before the next step instead of "soon".
  beforeAll(() => notifyManager.setScheduler((cb) => cb()));
  afterAll(() => notifyManager.setScheduler((cb) => setTimeout(cb, 0)));

  it('a refetch from an earlier save does not undo a newer click, and the stored list is the last one set', async () => {
    const user = userEvent.setup();
    const server = slowServer({ methods: null, partial: null });
    await openInvoicePage(server);

    await user.click(method(/^card$/i));
    await server.answer('patch'); // the first save lands; the page starts refetching the invoice
    await waitFor(() => expect(server.pending('get')).toBe(1));
    await user.click(method(/^check$/i)); // the next click comes before that refetch returns
    await server.answer('get'); // the refetch brings the list from the first save

    // The screen still shows what the user set, so the next click builds on it.
    expect(method(/^check$/i)).not.toBeChecked();
    await user.click(method(/^cash$/i));
    await server.settle();

    expect(server.stored.methods).toEqual(['ACH']);
    expect(method(/^card$/i)).not.toBeChecked();
    expect(method(/^check$/i)).not.toBeChecked();
    expect(method(/^cash$/i)).not.toBeChecked();
    expect(method(/^bank$/i)).toBeChecked();
  });

  it('the stored list is the last one set even when the server would answer the saves out of order', async () => {
    const user = userEvent.setup();
    const server = slowServer({ methods: null, partial: null });
    await openInvoicePage(server);

    await user.click(method(/^card$/i));
    await user.click(method(/^check$/i));
    while (server.pending('patch') > 0) await server.answerNewest('patch');
    await server.settle();

    expect(server.stored.methods).toEqual(['ACH', 'CASH']);
    expect(method(/^check$/i)).not.toBeChecked();
    expect(method(/^cash$/i)).toBeChecked();
  });

  it('the partial switch is not flipped back by a refetch from an earlier save', async () => {
    const user = userEvent.setup();
    const server = slowServer({ methods: null, partial: null });
    await openInvoicePage(server);
    const partial = () => screen.getByRole('switch', { name: /allow partial payments/i });

    await user.click(partial()); // on
    await server.answer('patch');
    await waitFor(() => expect(server.pending('get')).toBe(1));
    await user.click(partial()); // off again, before the refetch returns
    await server.answer('get'); // the refetch says "on"

    expect(partial()).not.toBeChecked();
    await server.settle();
    expect(server.stored.partial).toBeNull();
    expect(partial()).not.toBeChecked();
  });
});

describe('Payment options in two places for one invoice', () => {
  beforeAll(() => notifyManager.setScheduler((cb) => cb()));
  afterAll(() => notifyManager.setScheduler((cb) => setTimeout(cb, 0)));

  // Slice 25 (slice 21b review): each card queued its own saves, so a change in the send sheet
  // raced one made on the detail page and could store a list built without it.
  it('a change in one card shows in the other, and their saves go in order', async () => {
    const user = userEvent.setup();
    const server = slowServer({ methods: null, partial: null });
    renderWithProviders(<InvoicePage org={FOUR_METHODS} cards={2} />);
    await server.answer('get');
    const [detail, sheet] = await screen.findAllByTestId('invoice-payment-options');
    const box = (card: HTMLElement, name: RegExp) => within(card).getByRole('checkbox', { name });

    await user.click(box(detail, /^card$/i));
    expect(box(sheet, /^card$/i)).not.toBeChecked();

    await user.click(box(sheet, /^check$/i));
    expect(server.pending('patch')).toBe(1); // the sheet's save waits behind the detail page's
    while (server.pending('patch') > 0) await server.answerNewest('patch');
    await server.settle();

    expect(server.stored.methods).toEqual(['ACH', 'CASH']);
    for (const card of [detail, sheet]) {
      expect(box(card, /^card$/i)).not.toBeChecked();
      expect(box(card, /^check$/i)).not.toBeChecked();
      expect(box(card, /^cash$/i)).toBeChecked();
    }
  });
});

describe('Payment options after a failed save', () => {
  beforeAll(() => notifyManager.setScheduler((cb) => cb()));
  afterAll(() => notifyManager.setScheduler((cb) => setTimeout(cb, 0)));

  // Slice 25 (slice 21b verifier): only the toast said the save failed; the screen kept the
  // unsaved choices because the refetch brought back the same stored value it started from.
  it('puts the stored choices back on screen once the invoice is read again', async () => {
    const user = userEvent.setup();
    const server = slowServer({ methods: null, partial: null });
    await openInvoicePage(server);
    const partial = () => screen.getByRole('switch', { name: /allow partial payments/i });

    await user.click(method(/^card$/i));
    await user.click(partial());
    expect(method(/^card$/i)).not.toBeChecked();
    expect(partial()).toBeChecked();

    await server.fail(); // the card change is refused
    await server.fail(); // and so is the partial switch, which waited behind it
    await server.settle();

    expect(server.stored).toEqual({ methods: null, partial: null });
    expect(method(/^card$/i)).toBeChecked();
    expect(partial()).not.toBeChecked();
  });
});

describe('Payment options in the send sheet', () => {
  it('shows the same options before sending, and a change saves to this invoice', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SendInvoiceDialog
        open
        onOpenChange={() => {}}
        invoiceId="inv-1"
        invoiceNumber="I00021"
        customerEmail="payer@example.test"
        dueDate={null}
        totalAmount={500}
        amountDue={500}
        lineItems={[]}
        onSuccess={() => {}}
        paymentOptions={{
          paymentMethodsOverride: null,
          allowPartialPayment: null,
          org: { ...ORG, accepted_payment_methods: [...ORG.accepted_payment_methods] },
          canEdit: true,
        }}
      />,
    );
    expect(await screen.findByText('Payment options')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /allow partial payments/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/invoices/inv-1', { allow_partial_payment: true }));
  });
});
