// Settings -> Sender Address, which replaces the guided custom-domain page.
//
// Sending is in-house: every org sends from the one shared platform domain, so
// the domain is rendered as a fixed suffix and only the local part - the string
// before the `@` - is editable. The page it replaces offered the opposite model
// and, because that feature genuinely worked, contradicted the decision rather
// than merely describing it wrongly.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import EmailSenderPage from '@/pages/settings/EmailSenderPage';

const mockApi = vi.mocked(api);

const adminAbility = buildAbility([{ action: 'update', subject: 'Organization' }]);
const nonAdminAbility = buildAbility([{ action: 'read', subject: 'Job' }]);

const DOMAIN = 'mail.servwave.com';

function mockIdentity(over: Partial<{ localPart: string; localPartIsCustom: boolean }> = {}) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/sending-identity') {
      return {
        data: {
          address: `${over.localPart ?? 'northwindservices'}@${DOMAIN}`,
          name: 'Northwind Services',
          sendingEnabled: true,
          localPart: over.localPart ?? 'northwindservices',
          localPartIsCustom: over.localPartIsCustom ?? false,
          senderDomain: DOMAIN,
        },
      };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Non-empty org_features is what flips useEntitlementsReady() true. Without
  // it useSendingIdentity never fires and the page sits on its skeleton
  // forever, so every assertion below fails for a reason that is not the page.
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        org_features: ['email'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
  mockIdentity();
  mockApi.patch.mockResolvedValue({
    data: { local_part: 'service', local_part_is_custom: true, sender_domain: DOMAIN },
  });
});

const render = (ability = adminAbility) => renderWithProviders(<EmailSenderPage />, { ability });

describe('EmailSenderPage - what is editable', () => {
  it('seeds the field with the address the org currently sends from', async () => {
    render();

    expect(await screen.findByDisplayValue('northwindservices')).toBeInTheDocument();
  });

  it('shows the domain as fixed text, never as an input', async () => {
    // The whole point: an org cannot choose a domain, so the suffix must not be
    // an editable control that re-offers the retired custom-domain model.
    render();
    await screen.findByDisplayValue('northwindservices');

    expect(screen.getByText(`@${DOMAIN}`)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(DOMAIN)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(`@${DOMAIN}`)).not.toBeInTheDocument();
  });

  it('says the address is following the company name when nothing is set', async () => {
    render();

    expect(await screen.findByText(/follows your company name/i)).toBeInTheDocument();
  });

  it('offers to clear back to the default once a custom value is set', async () => {
    mockIdentity({ localPart: 'service', localPartIsCustom: true });
    render();

    expect(await screen.findByText(/clear the field to go back/i)).toBeInTheDocument();
  });

  it('warns that changing it affects every future email', async () => {
    render();

    expect(await screen.findByRole('status')).toHaveTextContent(/every future email/i);
  });
});

describe('EmailSenderPage - saving', () => {
  it('sends only the local part, never a domain', async () => {
    const user = userEvent.setup();
    render();
    const input = await screen.findByDisplayValue('northwindservices');

    await user.clear(input);
    await user.type(input, 'service');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.patch).toHaveBeenCalledWith('/api/organization/email-sender', {
      local_part: 'service',
    });
  });

  it('sends an empty value to clear the override', async () => {
    mockIdentity({ localPart: 'service', localPartIsCustom: true });
    const user = userEvent.setup();
    render();
    const input = await screen.findByDisplayValue('service');

    await user.clear(input);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.patch).toHaveBeenCalledWith('/api/organization/email-sender', { local_part: '' });
  });

  it('cannot save an unchanged value', async () => {
    render();
    await screen.findByDisplayValue('northwindservices');

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('rejects an @ before making a request', async () => {
    // The likeliest thing an admin types into a field like this is the whole
    // address; catching it client-side explains why rather than 400ing.
    const user = userEvent.setup();
    render();
    const input = await screen.findByDisplayValue('northwindservices');

    await user.clear(input);
    await user.type(input, 'service@northwind.com');

    expect(screen.getByText(/no spaces, dots or @/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('rejects spaces and dots the same way', async () => {
    const user = userEvent.setup();
    render();
    const input = await screen.findByDisplayValue('northwindservices');

    await user.clear(input);
    await user.type(input, 'front.desk');

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('does not overwrite what the admin is typing when the query refetches', async () => {
    // The mutation invalidates the identity query, so a naive effect that seeds
    // from server data on every change would yank the field back mid-edit.
    const user = userEvent.setup();
    render();
    const input = await screen.findByDisplayValue('northwindservices');

    await user.clear(input);
    await user.type(input, 'service');
    mockIdentity({ localPart: 'somethingelse', localPartIsCustom: true });

    expect(input).toHaveValue('service');
  });
});

describe('EmailSenderPage - gating', () => {
  it('renders nothing for a non-admin and never fetches', async () => {
    render(nonAdminAbility);

    expect(screen.queryByText(/sender address/i)).not.toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});
