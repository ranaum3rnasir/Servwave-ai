// Roles & Permissions security, M8 / D3 (ticket 36): who reads the main mailbox is an Admin's alone to change.
// Settings -> Sender Address: a holder of Company settings who is not an Admin still sees who the readers are (and the rest of
// the page), but is offered no Remove, no Add person, and the picker's list is never asked for. An Admin has all three.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import EmailSenderPage from '@/pages/settings/EmailSenderPage';

const mockApi = vi.mocked(api);
vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const holderAbility = buildAbility([{ action: 'update', subject: 'Organization' }]);
const READERS = '/api/organization/email-sender/readers';

function signIn(isAdmin: boolean) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-1', email: 'holder@test.com', first_name: 'Test', last_name: 'Holder', role: 'DISPATCHER', is_admin: isAdmin, org_features: ['email'] },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization/email-sender') {
      return { data: { address: 'acme@mail.servwave.com', local_part: 'acme', local_part_is_custom: false, sender_domain: 'mail.servwave.com' } };
    }
    if (url === READERS) return { data: { items: [{ id: 'u-9', name: 'Jane Smith' }], total: 1, offset: 0, limit: 50 } };
    return { data: {} };
  });
});

const block = async () => {
  const heading = await screen.findByRole('heading', { name: 'People who read the main mailbox' });
  return heading.parentElement!.parentElement as HTMLElement;
};

describe('Sender Address: changing who reads the main mailbox is an Admin\'s alone', () => {
  it('shows a non-Admin who holds Company settings the readers, with no Remove and no Add person, and never asks for the picker\'s list', async () => {
    signIn(false);
    renderWithProviders(<EmailSenderPage />, { ability: holderAbility });
    const section = await block();
    const list = await within(section).findByRole('list', { name: 'People who read the main mailbox' });
    expect(within(list).getByText('Jane Smith')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /Add person/ })).not.toBeInTheDocument();
    expect(mockApi.get.mock.calls.map((c) => c[0])).not.toContain(`${READERS}/candidates`);
    // The rest of the page is there: the sender address itself is still theirs to change.
    expect(await screen.findByLabelText('Company part')).toBeInTheDocument();
  });

  it('gives an Admin the Remove and Add person controls', async () => {
    signIn(true);
    renderWithProviders(<EmailSenderPage />, { ability: holderAbility });
    const section = await block();
    expect(await within(section).findByRole('button', { name: 'Remove Jane Smith' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: /Add person/ })).toBeInTheDocument();
  });
});
