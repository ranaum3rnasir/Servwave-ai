import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { DetailHeader, type DetailHeaderAction } from '@/components/detail/DetailHeader';
import { DropdownMenuItem } from '@/ui-kit/components/ui/dropdownMenu';
import { MEDIA } from '@/ui-kit/lib/breakpoints';

// Mobile slice 55: the shared detail header takes the other five records (customer, invoice,
// estimate, lead, automation builder). These are the options those pages need from it.

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const originalMatchMedia = window.matchMedia;

function setPhone(isPhone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: isPhone && query === MEDIA.belowSm,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  mockNavigate.mockReset();
});
afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
  window.history.replaceState(null, '');
});

const secondary: DetailHeaderAction[] = [
  { key: 'resend', label: 'Resend', inline: true, buttonVariant: 'outline', onSelect: vi.fn() },
  { key: 'refund', label: 'Refund', inline: true, buttonVariant: 'destructive', buttonSize: 'sm', onSelect: vi.fn() },
  { key: 'edit', label: 'Edit', onSelect: vi.fn() },
];

function header(extra: Partial<React.ComponentProps<typeof DetailHeader>> = {}) {
  return (
    <MemoryRouter>
      <DetailHeader
        backTo="/invoices"
        backLabel="Back to invoices"
        identity={<span>INV-1 · A very long customer name</span>}
        meta={<span>Sent</span>}
        primary={<button type="button">Record Payment</button>}
        secondary={secondary}
        {...extra}
      />
    </MemoryRouter>
  );
}

describe('DetailHeader options for the other records (mobile slice 55)', () => {
  it('keeps an inline action looking like the page had it: its own variant and size', () => {
    setPhone(false);
    render(header());
    expect(screen.getByRole('button', { name: 'Resend' }).className).toContain('border-input');
    expect(screen.getByRole('button', { name: 'Refund' }).className).toContain('bg-destructive-solid');
    expect(screen.getByRole('button', { name: 'Refund' }).className).toContain('h-8.5');
  });

  it('puts the primary action first from sm up when the page says so, and last otherwise', () => {
    setPhone(false);
    const { unmount } = render(header({ primaryFirst: true }));
    let names = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    expect(names.slice(0, 3)).toEqual(['Record Payment', 'Resend', 'Refund']);
    unmount();
    render(header());
    names = screen.getAllByRole('button').map((b) => b.textContent?.trim());
    expect(names.slice(0, 3)).toEqual(['Resend', 'Refund', 'Record Payment']);
  });

  it('renders page-owned menu items inside the menu, after the listed actions, on a phone and from sm up', async () => {
    const user = userEvent.setup();
    for (const phone of [true, false]) {
      setPhone(phone);
      const { unmount } = render(
        header({ menuExtra: <DropdownMenuItem onSelect={() => {}}>Copy Link</DropdownMenuItem> }),
      );
      await user.click(screen.getByRole('button', { name: 'Actions' }));
      const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent?.trim());
      // On a phone every secondary action is folded in; wide, only the non-inline one is.
      expect(items).toEqual(phone ? ['Resend', 'Refund', 'Edit', 'Copy Link'] : ['Edit', 'Copy Link']);
      await user.keyboard('{Escape}');
      unmount();
    }
  });

  it('shows an icon-only menu trigger from sm up (named by the label) and the labelled full-width button on a phone', () => {
    setPhone(false);
    const { unmount } = render(header({ menuLabel: 'More actions', menuIconOnly: true }));
    const wide = screen.getByRole('button', { name: 'More actions' });
    expect(wide.textContent?.trim()).toBe('');
    unmount();
    setPhone(true);
    render(header({ menuLabel: 'More actions', menuIconOnly: true }));
    const phone = screen.getByRole('button', { name: 'More actions' });
    expect(phone.textContent).toContain('More actions');
    expect(phone.className).toContain('w-full');
  });

  it('keeps the Back control from sm up when the page asks, and Back goes to the parent when told to', async () => {
    setPhone(false);
    const user = userEvent.setup();
    // An earlier in-app entry exists, yet the page insists on its parent list (a deep link target).
    window.history.replaceState({ idx: 3 }, '');
    render(header({ backFromSm: true, backMode: 'parent' }));
    await user.click(screen.getByRole('button', { name: 'Back to invoices' }));
    expect(mockNavigate).toHaveBeenCalledWith('/invoices');
    expect(mockNavigate).not.toHaveBeenCalledWith(-1);
  });

  it('shows the aside (the invoice amount due) on a phone and from sm up', () => {
    for (const phone of [true, false]) {
      setPhone(phone);
      const { unmount } = render(header({ aside: <p data-testid="aside">$1,200.00</p> }));
      expect(within(screen.getByTestId('detail-header')).getByTestId('aside')).toBeInTheDocument();
      unmount();
    }
  });

  it('lets the identity shrink: its column is min-w-0, so a long name truncates instead of collapsing', () => {
    setPhone(true);
    render(header());
    const identity = screen.getByText(/A very long customer name/).parentElement!;
    expect(identity.className).toContain('min-w-0');
    expect(identity.className).toContain('flex-1');
  });
});
