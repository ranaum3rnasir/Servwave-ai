import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderLeadForm, serveLeadForm } from '@/__tests__/harness/leadFormPage';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/lib/api/shared/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('leadFormTextLength', () => {
  /**
   * Text length limits (spec 2026-10-14). The service request and notes take 20,000 characters. The form says so
   * BEFORE save, inline, instead of the server's raw "service_request: String must contain at most 2000 character(s)".
   */

  const mockApi = vi.mocked(api);
  const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

  beforeEach(() => {
    vi.clearAllMocks();
    serveLeadForm();
  });

  function mount() {
    renderLeadForm({ ability: adminAbility, entry: '/leads/new?phone=%2B16098745252' });
  }

  const type = (placeholder: string, value: string) =>
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

  describe('LeadFormPage (routed, create) - long text', () => {
    it('refuses a 20,001-character service request inline, before any request is sent', async () => {
      mount();
      await waitFor(() => expect(screen.getByDisplayValue('(609) 874-5252')).toBeInTheDocument());
      type('Describe the service needed...', 'x'.repeat(20_001));
      fireEvent.click(screen.getByRole('button', { name: /create lead/i }));

      expect(await screen.findByText('Too long (maximum 20,000 characters)')).toBeInTheDocument();
      expect(mockApi.post).not.toHaveBeenCalled();
    });

    it('refuses 20,001 characters of notes with a visible message', async () => {
      mount();
      await waitFor(() => expect(screen.getByDisplayValue('(609) 874-5252')).toBeInTheDocument());
      type('Describe the service needed...', 'Door sticks');
      type('Internal notes...', 'x'.repeat(20_001));
      fireEvent.click(screen.getByRole('button', { name: /create lead/i }));

      expect(await screen.findByText('Too long (maximum 20,000 characters)')).toBeInTheDocument();
    });

    it('shows a character counter from 90% of the limit, and not below it', async () => {
      mount();
      await waitFor(() => expect(screen.getByDisplayValue('(609) 874-5252')).toBeInTheDocument());

      type('Describe the service needed...', 'x'.repeat(17_999));
      expect(screen.queryByText('17,999 / 20,000')).toBeNull();

      type('Describe the service needed...', 'x'.repeat(18_000));
      expect(await screen.findByText('18,000 / 20,000')).toBeInTheDocument();
    });
  });
});

describe('leadFormPhonePrefill', () => {
  /**
   * Roles & Permissions S02.27 - "Create lead" in the Texts inbox and the dialer opens /leads/new?phone=<e164>. The
   * ROUTED lead form (pages/v2) puts that number, country code stripped and masked, in its new-customer part.
   */

  const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

  beforeEach(() => {
    vi.clearAllMocks();
    serveLeadForm();
  });

  describe('LeadFormPage (routed, create) - ?phone= create-prefill (S02.27)', () => {
    it('seeds the phone field from /leads/new?phone=<e164>, country code stripped and masked', async () => {
      renderLeadForm({
        ability: adminAbility,
        entry: '/leads/new?phone=%2B16098745252',
      });

      await waitFor(() => expect(screen.getByDisplayValue('(609) 874-5252')).toBeInTheDocument());
    });
  });
});
