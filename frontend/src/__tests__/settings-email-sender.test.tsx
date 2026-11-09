// Settings -> Sender Address (PRD 10, S10.26): the company's main address, the company part in it, and the change of that
// part, which gives everyone a new address while every old one keeps receiving.
//
// Sending is in-house: every company sends from the one shared domain, so the domain is rendered as a fixed suffix and
// only the company part - the string before the `@` - is editable. The page renders from the route's own file.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import EmailSenderPage from '@/pages/settings/EmailSenderPage';
import { settingsV2Routes } from '@/pages/v2/routes/settings.routes';

vi.mock('@/components/ProtectedRoute', () => ({ default: () => <Outlet /> }));
vi.mock('@/pages/v2/V2AppLayout', () => ({ default: () => <Outlet /> }));

const mockApi = vi.mocked(api);

const holderAbility = buildAbility([{ action: 'update', subject: 'Organization' }]);
const nonHolderAbility = buildAbility([{ action: 'read', subject: 'Job' }]);

const DOMAIN = 'mail.servwave.com';
const TAKEN = 'This email address is already in use. Choose a different one.';

function mockSender(over: Partial<{ localPart: string; custom: boolean }> = {}) {
  const part = over.localPart ?? 'acmeplumbing';
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization/email-sender') {
      return {
        data: { address: `${part}@${DOMAIN}`, local_part: part, local_part_is_custom: over.custom ?? false, sender_domain: DOMAIN },
      };
    }
    return { data: {} };
  });
}

function signIn(features: string[] = ['email'], isAdmin = false) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'holder@test.com',
        first_name: 'Test',
        last_name: 'Holder',
        role: 'ADMIN',
        is_admin: isAdmin,
        org_features: features,
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Non-empty org_features is what flips useEntitlementsReady() true; without it nothing is fetched and the page sits on
  // its skeleton, so every assertion below would fail for a reason that is not the page.
  signIn();
  mockSender();
  mockApi.patch.mockResolvedValue({
    data: { local_part: 'service', local_part_is_custom: true, sender_domain: DOMAIN },
  });
});

const render = (ability = holderAbility) => renderWithProviders(<EmailSenderPage />, { ability });

/** The calls that ask whether a part would be accepted (nothing changes), and the calls that really change it. */
const patches = () => mockApi.patch.mock.calls.map(([, body]) => body as { local_part: string; dry_run?: boolean });
const askedCalls = () => patches().filter((b) => b.dry_run === true);
const changeCalls = () => patches().filter((b) => b.dry_run !== true);

describe('EmailSenderPage - what it shows', () => {
  it('shows the main address and seeds the company part field from it', async () => {
    render();

    expect(await screen.findByDisplayValue('acmeplumbing')).toBeInTheDocument();
    expect(screen.getByLabelText('Main address')).toHaveTextContent(`acmeplumbing@${DOMAIN}`);
  });

  it('says the main address is for automated email, hand-sent email goes from each person, and everyone has an address on the same domain', async () => {
    render();
    await screen.findByDisplayValue('acmeplumbing');

    expect(screen.getByText(/main address is used for automated email/i)).toBeInTheDocument();
    expect(screen.getByText(/goes from their own address/i)).toBeInTheDocument();
    expect(screen.getByText(/has their own address on the same domain/i)).toBeInTheDocument();
    // the retired wording promised the one address on every document
    expect(screen.queryByText(/estimates, invoices and receipts/i)).not.toBeInTheDocument();
  });

  it('shows the domain as fixed text, never as an input', async () => {
    render();
    await screen.findByDisplayValue('acmeplumbing');

    expect(screen.getByText(`@${DOMAIN}`)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(DOMAIN)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(`@${DOMAIN}`)).not.toBeInTheDocument();
  });

  it('says the part is following the company name when nothing is set, and how to go back once it is custom', async () => {
    render();
    expect(await screen.findByText(/follows your company name/i)).toBeInTheDocument();
  });

  it('offers to clear back to the default once a custom value is set', async () => {
    mockSender({ localPart: 'service', custom: true });
    render();
    expect(await screen.findByText(/clear the field to go back/i)).toBeInTheDocument();
  });

  it('names no email provider or vendor anywhere on the page', async () => {
    const { container } = render();
    await screen.findByDisplayValue('acmeplumbing');

    expect(container.textContent ?? '').not.toMatch(/resend|ctm|calltracking|supabase|render\.com|twilio|stripe|sendgrid|mailgun|postmark|ses\b/i);
  });

  it('fits a phone: the field row wraps and the long addresses break instead of running off the screen', async () => {
    render();
    await screen.findByDisplayValue('acmeplumbing');

    expect(screen.getByLabelText('Main address').className).toMatch(/break-all/);
    const input = screen.getByLabelText('Company part');
    expect(input.parentElement?.className).toMatch(/flex-wrap/);
    expect(screen.getByText(`@${DOMAIN}`).className).toMatch(/break-all/);
  });
});

describe('EmailSenderPage - changing the company part', () => {
  async function typePart(value: string) {
    const user = userEvent.setup();
    render();
    const input = await screen.findByDisplayValue('acmeplumbing');
    await user.clear(input);
    await user.type(input, value);
    return user;
  }

  it('warns before anything is saved: everyone gets a new address, every old one keeps receiving forever and is never given to anyone else', async () => {
    const user = await typePart('service');

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/everyone at your company gets a new address/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/every old address keeps receiving email forever and is never given to anyone else/i)).toBeInTheDocument();
    // The server was asked first, and only asked: nothing was changed.
    expect(askedCalls()).toEqual([{ local_part: 'service', dry_run: true }]);
    expect(changeCalls()).toEqual([]);
  });

  it('saves only after the warning is confirmed, sending only the company part', async () => {
    const user = await typePart('service');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /change addresses/i }));

    await waitFor(() => expect(changeCalls()).toEqual([{ local_part: 'service' }]));
  });

  it('saves nothing when the warning is cancelled, and keeps what was typed', async () => {
    const user = await typePart('service');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /cancel/i }));

    expect(changeCalls()).toEqual([]);
    expect(screen.getByLabelText('Company part')).toHaveValue('service');
  });

  it('sends an empty value to go back to the company-name default', async () => {
    mockSender({ localPart: 'service', custom: true });
    const user = userEvent.setup();
    render();
    const input = await screen.findByDisplayValue('service');
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /change addresses/i }));

    await waitFor(() => expect(changeCalls()).toEqual([{ local_part: '' }]));
  });

  it('cannot save an unchanged value', async () => {
    render();
    await screen.findByDisplayValue('acmeplumbing');

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('rejects an @ or a dot before making a request', async () => {
    const user = await typePart('service@other.com');

    expect(screen.getByText(/no spaces, dots or @/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    await user.clear(screen.getByLabelText('Company part'));
    await user.type(screen.getByLabelText('Company part'), 'front.desk');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('shows a taken part under the field in the server\'s words before any warning, and never names a company', async () => {
    mockApi.patch.mockRejectedValue({ response: { status: 409, data: { error: TAKEN, code: 'LOCAL_PART_TAKEN' } } });
    const user = await typePart('service');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const message = await screen.findByText(TAKEN);
    expect(message.closest('[id]')?.id).toBe('email-sender-help');
    expect(screen.getByLabelText('Company part')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(changeCalls()).toEqual([]);
  });

  it('refuses a reserved part under the field in the server\'s words, without a field name in front, and never opens the warning', async () => {
    mockApi.patch.mockRejectedValue({
      response: { status: 400, data: { error: 'Validation failed', details: [{ field: 'local_part', message: 'This address is reserved.' }] } },
    });
    const user = await typePart('postmaster');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('This address is reserved.')).toBeInTheDocument();
    expect(screen.queryByText(/local_part/)).not.toBeInTheDocument();
    // No warning that promised postmaster@..., and nothing was sent but the question.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/postmaster@/i)).not.toBeInTheDocument();
    expect(askedCalls()).toEqual([{ local_part: 'postmaster', dry_run: true }]);
    expect(changeCalls()).toEqual([]);
  });

  it('shows the server\'s refusal of the real change too, when the part is lost between the question and the change', async () => {
    const user = await typePart('service');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    mockApi.patch.mockRejectedValue({ response: { status: 409, data: { error: TAKEN, code: 'LOCAL_PART_TAKEN' } } });
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /change addresses/i }));

    expect(await screen.findByText(TAKEN)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('takes the refusal away again once the person edits the field', async () => {
    mockApi.patch.mockRejectedValue({ response: { status: 409, data: { error: TAKEN, code: 'LOCAL_PART_TAKEN' } } });
    const user = await typePart('service');
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await screen.findByText(TAKEN);

    await user.type(screen.getByLabelText('Company part'), '2');

    expect(screen.queryByText(TAKEN)).not.toBeInTheDocument();
  });

  it('does not overwrite what is being typed when the query refetches', async () => {
    await typePart('service');
    mockSender({ localPart: 'somethingelse', custom: true });

    expect(screen.getByLabelText('Company part')).toHaveValue('service');
  });
});

describe('EmailSenderPage - who sees it', () => {
  const noAccess = () => screen.findByRole('heading', { name: /you don.t have access to this page/i });

  it('says the person has no access, like the other settings pages, without Company settings, and never fetches', async () => {
    render(nonHolderAbility);

    expect(await noAccess()).toBeInTheDocument();
    expect(screen.queryByLabelText('Company part')).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/organization/email-sender');
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('says the same, and never fetches, when the company\'s plan has no Email feature', async () => {
    signIn(['calendar']);
    render();

    expect(await noAccess()).toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/organization/email-sender');
  });

  it('is what the routed /settings/email-sender address draws for a person who is not an Admin: nothing, and no read', async () => {
    const routed = (ability: typeof holderAbility) =>
      renderWithProviders(
        <Suspense fallback={null}>
          <Routes>{settingsV2Routes()}</Routes>
        </Suspense>,
        { initialEntries: ['/settings/email-sender'], ability },
      );

    // First the same address for an Admin, which DOES draw the page: this loads the route's lazy page, so what
    // follows is judged against a page that would appear at once (no timer to wait out a cold chunk).
    signIn(['email'], true);
    const admin = routed(holderAbility);
    expect(await screen.findByLabelText('Company part')).toBeInTheDocument();
    admin.unmount();

    // Setting up the company is the Admin flag's alone (36b, M17): the route renders nothing for anyone else,
    // even a person whose rules hold the old Company settings update.
    signIn(['email'], false);
    mockApi.get.mockClear();
    routed(holderAbility);
    await screen.findByRole('navigation', { name: 'Settings' });
    expect(screen.queryByLabelText('Company part')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/organization/email-sender');
  });
});
