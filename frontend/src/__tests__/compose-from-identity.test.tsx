import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { ComposeWindow, InlineComposer } from '@/components/communication/inbox/ComposeWindow';
import type { ComposeState, Email, ReplyDraft } from '@/lib/api/communication';
import CustomerDetailPage from '@/pages/CustomerDetailPage';

// SRVW-88 - the compose surfaces must never invent a From identity. With no
// sending mailbox they say so honestly; when one is passed in they render it
// verbatim. Guards the three compose surfaces, the AI draft signature, and the
// Customers-page composer that had no mailbox awareness at all.

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const LIVE_ADDRESS = 'ops@realorg.example.com';
const NO_MAILBOX = 'No mailbox connected';
// Assembled from parts so the source-scan guards below cannot match this file.
const SEED_ADDRESS_NEEDLE = ['emanuel', '@', 'northwind.example.com'].join('');
const DEAD_READ_NEEDLE = ['acct', '.address'].join('');

const COMPOSE: ComposeState = {
  mode: 'new',
  account: 'system',
  to: '',
  subject: '',
  body: '',
};

const ORIGINAL: Email = {
  id: 'e1',
  account: 'system',
  from: { name: 'Maria Garcia', email: 'maria.garcia@example.com' },
  to: LIVE_ADDRESS,
  subject: 'Quote request',
  snippet: 'Can you quote the vault hardware?',
  body: ['Can you quote the vault hardware?'],
  at: 'May 1',
  ts: 1,
  unread: false,
  starred: false,
  folder: 'inbox',
};

const REPLY: ReplyDraft = {
  emailId: 'e1',
  mode: 'reply',
  account: 'system',
  to: 'maria.garcia@example.com',
  subject: 'Re: Quote request',
  body: '',
};

function noop() {}

/** Signed-in user with the comms entitlement resolved (readiness true). */
function mockEntitledUser() {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        organization_id: 'org-1',
        org_features: ['phone'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001',
  customer_number: 'C00001',
  first_name: 'Maria',
  last_name: 'Garcia',
  company_name: null,
  email: 'maria.garcia@example.com',
  extra_emails: [],
  phone: '4695550391',
  phone_ext: null,
  secondary_phone: null,
  secondary_phone_ext: null,
  ad_source: 'Google',
  allow_billing: false,
  tax_exempt: false,
  payment_type: null,
  notes: null,
  is_active: true,
  archived_at: null,
  created_at: '2026-04-01T00:00:00.000Z',
  service_locations: [],
  _count: { jobs: 0, leads: 0 },
  jobs: [],
  invoices: [],
};

const SUMMARY = {
  financials: {
    lifetime_revenue: 0,
    total_invoiced: 0,
    past_due_balance: 0,
    due_balance: 0,
    paid_invoice_count: 0,
    unpaid_invoice_count: 0,
  },
  estimates: { total: 0, pending: 0, approved: 0, total_value: 0 },
  deposits: { collected: 0, pending: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEntitledUser();
  mockApi.get.mockImplementation(() =>
    Promise.resolve({ data: { customer: CUSTOMER, summary: SUMMARY } }),
  );
});

describe('ComposeWindow From identity', () => {
  it('shows the unconnected state, never a seed address, when no mailbox is connected', () => {
    const { container } = renderWithProviders(
      <ComposeWindow
        state={COMPOSE}
        onChange={noop}
        onSend={noop}
        onClose={noop}
        onDiscard={noop}
        onToast={noop}
      />,
    );

    expect(screen.getByText(NO_MAILBOX)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/@northwind\.com/);
  });

  it('renders a live mailbox address verbatim', () => {
    renderWithProviders(
      <ComposeWindow
        state={COMPOSE}
        onChange={noop}
        onSend={noop}
        onClose={noop}
        onDiscard={noop}
        onToast={noop}
        fromAddress={LIVE_ADDRESS}
      />,
    );

    expect(screen.getByText(LIVE_ADDRESS)).toBeInTheDocument();
    expect(screen.queryByText(NO_MAILBOX)).toBeNull();
  });

  it('signs an AI draft with the signed-in user, not a hardcoded owner', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onChange = vi.fn();
    renderWithProviders(
      <ComposeWindow
        state={COMPOSE}
        onChange={onChange}
        onSend={noop}
        onClose={noop}
        onDiscard={noop}
        onToast={noop}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'AI' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Draft an email' }));

    expect(onChange).toHaveBeenCalled();
    const drafted = (onChange.mock.calls[0]![0] as ComposeState).body;
    expect(drafted).toContain('Test Admin');
    expect(drafted).not.toContain('Emanuel Dahan');
  });
});

describe('InlineComposer From identity', () => {
  it('shows the unconnected state in both the From label and the account chips', () => {
    const { container } = renderWithProviders(
      <InlineComposer
        reply={REPLY}
        original={ORIGINAL}
        onChange={noop}
        onSend={noop}
        onDiscard={noop}
        onPopOut={noop}
        onToast={noop}
      />,
    );

    // Twice: the header From label and the single honest chip that replaces the
    // two-item prototype account list.
    expect(screen.getAllByText(NO_MAILBOX)).toHaveLength(2);
    expect(container.textContent).not.toMatch(/@northwind\.com/);
    expect(container.textContent).not.toContain('no-reply@servwave.app');
  });
});

describe('CustomerDetailPage composer From identity', () => {
  // There is no per-org sending mailbox today, so the honest answer here is the
  // unconnected state - NOT a seed address, and not the transactional sender.
  it('shows the unconnected state, never an invented address', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { container } = renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialEntries: [`/customers/${CUSTOMER.id}`], ability: ADMIN },
    );

    await screen.findByRole('heading', { name: /Maria Garcia/ });
    await user.click(screen.getByRole('button', { name: CUSTOMER.email }));

    expect(await screen.findByText(NO_MAILBOX)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/@northwind\.com/);
    expect(container.textContent).not.toContain('no-reply@servwave.app');
  });
});

describe('source guards', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(here, '..');
  const sourceFiles = readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx)$/.test(f));

  it('no source file under frontend/src contains the real personal address', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
    const offenders = sourceFiles.filter((rel) =>
      readFileSync(join(srcDir, rel), 'utf8').includes(SEED_ADDRESS_NEEDLE),
    );
    expect(offenders).toEqual([]);
  });

  it('no dead Account.address reads or orphaned account locals survive', () => {
    const offenders = sourceFiles.filter((rel) =>
      readFileSync(join(srcDir, rel), 'utf8').includes(DEAD_READ_NEEDLE),
    );
    expect(offenders).toEqual([]);
  });
});
