// Payments go-live P8 + v7 - the Documents tab lists the files the team uploaded and hosts the processor's embedded
// Documents component under the list. The component is mocked (it does not render in jsdom); everything the tab decides
// is real. The mounting / failure cases carry the viewer-session assertions of the retired Settings > ServWave
// Payments page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { DocumentRow } from '@/lib/api/paymentsPage';
import { downloadAttachment } from '@/lib/attachments/downloadAttachment';
import { resetAccountScopedStores } from '@/lib/storeReset';

import DocumentsTab from '../tabs/DocumentsTab';
import { RANGE, mockApi } from './paymentsFixtures';

const hoisted = vi.hoisted(() => ({
  load: vi.fn(),
  logout: vi.fn(),
  onLoadError: undefined as undefined | ((e: unknown) => void),
}));

vi.mock('@/lib/attachments/downloadAttachment', () => ({ downloadAttachment: vi.fn() }));
const mockDownload = vi.mocked(downloadAttachment);

vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: hoisted.load }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="connect-provider">{children}</div>,
  ConnectDocuments: ({ onLoadError }: { onLoadError?: (e: unknown) => void }) => {
    hoisted.onLoadError = onLoadError;
    return <div data-testid="embedded-documents" />;
  },
}));

const ADMIN = buildAbility([
  { action: 'view_payments', subject: 'Organization' },
  { action: 'update', subject: 'Invoice' },
  // Edit invoices needs View invoices and See prices.
  { action: 'read', subject: 'Invoice' },
  { action: 'read', subject: 'Prices' },
]);
const READ_ONLY = buildAbility([{ action: 'view_payments', subject: 'Organization' }]);

const SIGNED = 'https://files.example.test/storage/v1/object/sign/attachments/org/invoice/inv-1/1758000000000-Signed_scope.pdf?token=t1';

function makeDoc(i: number, over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: `doc-${i}`,
    name: `Scope ${i}`,
    type: 'Uploaded',
    date: new Date(Date.UTC(2026, 9, 3, 12, 0) - i * 3_600_000).toISOString(),
    size: 1000 + i,
    attached_to: { kind: 'invoice', id: `inv-${i}`, label: `INV-${1000 + i}` },
    download_url: `${SIGNED}&n=${i}`,
    ...over,
  };
}

interface Serve { docs?: DocumentRow[]; total?: number; connected?: boolean; listFails?: boolean }
let docCalls: Array<Record<string, unknown>> = [];
function serveDocs({ docs = [], total, connected = true, listFails = false }: Serve = {}) {
  docCalls = [];
  mockApi.get.mockImplementation(((url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/Los_Angeles' } });
    if (url === '/api/organization/stripe/status') return Promise.resolve({ data: { connected } });
    if (url === '/api/payments-page/documents') {
      docCalls.push(config?.params ?? {});
      if (listFails) return Promise.reject(new Error('Network Error'));
      const page = Number(config?.params?.page ?? 1);
      const all = total ?? docs.length;
      const rows = total ? Array.from({ length: Math.min(25, all - (page - 1) * 25) }, (_, i) => makeDoc((page - 1) * 25 + i + 1)) : docs;
      return Promise.resolve({ data: { documents: rows, pagination: { page, limit: 25, total: all, totalPages: Math.max(1, Math.ceil(all / 25)) } } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  }) as never);
}

const tabState = { params: new URLSearchParams('tab=documents'), setParams: vi.fn() };
const renderTab = (ability = ADMIN) => renderWithProviders(<DocumentsTab range={RANGE} tabState={tabState} />, { ability });

const lastSession = () => hoisted.load.mock.calls[hoisted.load.mock.calls.length - 1]![0] as {
  fetchClientSecret: () => Promise<string>;
  appearance: { variables: Record<string, string> };
};
const libraryAsksForSecret = async () => { await lastSession().fetchClientSecret().catch(() => undefined); };
const FAILED = /Couldn.t load documents\./;

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
  resetAccountScopedStores(); // the shared embedded session is module state: start every test without one
  hoisted.logout.mockClear();
  hoisted.load.mockReturnValue({ logout: hoisted.logout });
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.post.mockResolvedValue({ data: { client_secret: 'cs_viewer' } });
  mockDownload.mockReset();
  serveDocs();
  consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => consoleSpies.forEach((s) => s.mockRestore()));

describe('mounting', () => {
  it('mounts the embedded Documents component inside the tab with the viewer connect', async () => {
    renderTab();
    expect(await screen.findByTestId('embedded-documents')).toBeInTheDocument();
    expect(screen.getByTestId('connect-provider')).toContainElement(screen.getByTestId('embedded-documents'));
    expect(hoisted.load).toHaveBeenCalledTimes(1);
  });

  it('asks for the viewer surface, never the owner one', async () => {
    renderTab();
    await screen.findByTestId('embedded-documents');
    await expect(lastSession().fetchClientSecret()).resolves.toBe('cs_viewer');
    expect(mockApi.post).toHaveBeenCalledWith('/api/organization/stripe/account-session', { surface: 'viewer' });
  });

  it('is not filtered by the period: the list asks for a page and a size, never the dates', async () => {
    renderTab();
    await screen.findByTestId('embedded-documents');
    await libraryAsksForSecret();
    await waitFor(() => expect(docCalls.length).toBeGreaterThan(0));
    for (const call of docCalls) {
      expect(call).not.toHaveProperty('from');
      expect(call).not.toHaveProperty('to');
    }
  });

  it('mounts the embedded box only when the organization has a payout account, and asks for no session before that', async () => {
    serveDocs({ connected: false });
    renderTab();
    await screen.findByText('No documents yet');
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/organization/stripe/status'));
    expect(screen.queryByTestId('embedded-documents')).not.toBeInTheDocument();
    expect(hoisted.load).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('ends the session on ServWave sign-out only', async () => {
    renderTab();
    await screen.findByTestId('embedded-documents');
    cleanup();
    expect(hoisted.logout).not.toHaveBeenCalled();
    resetAccountScopedStores();
    expect(hoisted.logout).toHaveBeenCalledTimes(1);
  });
});

describe('when the component or the session fails', () => {
  it('shows a retry state when the component reports a load error, and Retry starts a fresh session', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByTestId('embedded-documents');
    hoisted.onLoadError?.({ error: { type: 'api_error' } });
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    const loadsBefore = hoisted.load.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('embedded-documents');
    expect(hoisted.load.mock.calls.length).toBe(loadsBefore + 1);
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });

  it.each([
    ['a 429', Object.assign(new Error('Request failed with status code 429'), { response: { status: 429 } })],
    ['a 5xx', Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } })],
    ['a network error', Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })],
  ])('shows the retry state after %s, even though the component never calls its own error hook', async (_name, failure) => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValueOnce(failure);
    renderTab();
    await screen.findByTestId('embedded-documents');
    await libraryAsksForSecret();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();

    const loadsBefore = hoisted.load.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('embedded-documents');
    expect(hoisted.load.mock.calls.length).toBe(loadsBefore + 1);
    await libraryAsksForSecret();
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });

  it('clears the card once a later session request succeeds, even if the abandoned session failed late', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } }));
    renderTab();
    await screen.findByTestId('embedded-documents');
    const firstSession = lastSession();
    await libraryAsksForSecret();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('embedded-documents');
    mockApi.post.mockRejectedValueOnce(new Error('Network Error'));
    await firstSession.fetchClientSecret().catch(() => undefined);
    expect(await screen.findByText(FAILED)).toBeInTheDocument();

    await libraryAsksForSecret();
    await waitFor(() => expect(screen.queryByText(FAILED)).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows no retry state when the session request succeeds', async () => {
    renderTab();
    await screen.findByTestId('embedded-documents');
    await libraryAsksForSecret();
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });
});

describe('copy', () => {
  it('names no payment processor in the rendered text or the browser console', async () => {
    const { container } = renderTab();
    await screen.findByTestId('embedded-documents');
    hoisted.onLoadError?.({});
    await screen.findByText(FAILED);
    expect(container.textContent).not.toMatch(/stripe|acct_/i);
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/stripe/i);
    }
  });
});

describe('the uploaded documents list', () => {
  it('says "No documents yet" for an empty list and still shows the heading, the button and the box', async () => {
    renderTab();
    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload document' })).toBeInTheDocument();
    expect(await screen.findByTestId('embedded-documents')).toBeInTheDocument();
  });

  it('lists the five columns, "Uploaded" in Type, the date on the org clock, with the box under the table', async () => {
    serveDocs({ docs: [makeDoc(1, { name: 'Signed scope of work', date: '2026-10-03T03:00:00.000Z' })] });
    renderTab();
    const row = (await screen.findByText('Signed scope of work')).closest('tr')!;
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Document', 'Type', 'Attached to', 'Date', 'Download']);
    expect(within(row).getByText('Uploaded')).toBeInTheDocument();
    expect(within(row).getByText('Oct 2, 2026')).toBeInTheDocument(); // 03:00Z is still the 2nd in Los Angeles
    const box = await screen.findByTestId('embedded-documents');
    expect(screen.getByRole('table').compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the record as a chip that opens in a new tab, for each kind', async () => {
    serveDocs({ docs: [
      makeDoc(1, { attached_to: { kind: 'invoice', id: 'i-1', label: 'INV-1302' } }),
      makeDoc(2, { attached_to: { kind: 'job', id: 'j-1', label: 'J-4101' } }),
      makeDoc(3, { attached_to: { kind: 'customer', id: 'c-1', label: 'Dana Whitfield' } }),
    ] });
    renderTab();
    const invoice = await screen.findByRole('link', { name: /Invoice INV-1302/ });
    expect(invoice).toHaveAttribute('href', '/invoices/i-1');
    expect(invoice).toHaveAttribute('target', '_blank');
    expect(invoice.getAttribute('rel')).toContain('noopener');
    expect(invoice.getAttribute('rel')).toContain('noreferrer');
    expect(invoice).toHaveTextContent('(opens in a new tab)');
    expect(screen.getByRole('link', { name: /Job J-4101/ })).toHaveAttribute('href', '/jobs/j-1');
    expect(screen.getByRole('link', { name: /Customer Dana Whitfield/ })).toHaveAttribute('href', '/customers/c-1');
  });

  it('shows a dash and no Download for a file on a record the viewer cannot open', async () => {
    serveDocs({ docs: [
      makeDoc(1, { name: 'Open file' }),
      makeDoc(2, { name: 'Locked file', attached_to: { kind: 'customer', id: null, label: null }, download_url: null }),
    ] });
    renderTab();
    const locked = (await screen.findByText('Locked file')).closest('tr')!;
    expect(within(locked).getByText('—')).toBeInTheDocument();
    expect(within(locked).queryByRole('link')).not.toBeInTheDocument();
    expect(within(locked).queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    const open = screen.getByText('Open file').closest('tr')!;
    expect(within(open).getByRole('button', { name: 'Download Open file' })).toBeInTheDocument();
  });

  it('saves through the shared download helper with the row\'s URL and the stored name, and re-reads once for a fresh link', async () => {
    const u = userEvent.setup();
    serveDocs({ docs: [makeDoc(7, { name: 'Signed scope' })] });
    renderTab();
    await u.click(await screen.findByRole('button', { name: 'Download Signed scope' }));
    expect(mockDownload).toHaveBeenCalledTimes(1);
    const [input, opts] = mockDownload.mock.calls[0]!;
    expect(input).toMatchObject({ id: 'doc-7', file_url: makeDoc(7).download_url, display_name: 'Signed scope', file_name: '1758000000000-Signed_scope.pdf' });
    const callsBefore = docCalls.length;
    await expect(opts!.refresh!()).resolves.toBe(makeDoc(7).download_url);
    expect(docCalls.length).toBe(callsBefore + 1);
  });

  it('pages on the server, 25 at a time, for a list of 130', async () => {
    const u = userEvent.setup();
    serveDocs({ total: 130 });
    renderTab();
    await screen.findByText('Scope 1');
    expect(within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')).toHaveLength(25);
    expect(docCalls.at(-1)).toEqual({ page: 1, limit: 25 });
    await u.click(screen.getAllByRole('button', { name: 'Next page' })[0]!);
    expect(await screen.findByText('Scope 26')).toBeInTheDocument();
    expect(docCalls.at(-1)).toEqual({ page: 2, limit: 25 });
  });

  it('has no Upload document button without Create attachments, and the list is still readable', async () => {
    serveDocs({ docs: [makeDoc(1)] });
    renderTab(READ_ONLY);
    expect(await screen.findByText('Scope 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload document' })).not.toBeInTheDocument();
  });

  it('opens the Upload document dialog from the button', async () => {
    const u = userEvent.setup();
    renderTab();
    await u.click(await screen.findByRole('button', { name: 'Upload document' }));
    expect(await screen.findByRole('dialog', { name: 'Upload document' })).toBeInTheDocument();
  });

  it.each([
    ['Escape', async (u: ReturnType<typeof userEvent.setup>) => { await u.keyboard('{Escape}'); }],
    ['Cancel', async (u: ReturnType<typeof userEvent.setup>) => { await u.click(screen.getByRole('button', { name: 'Cancel' })); }],
  ])('puts focus back on "Upload document" when the dialog is closed with %s', async (_n, close) => {
    const u = userEvent.setup();
    renderTab();
    const opener = await screen.findByRole('button', { name: 'Upload document' });
    await u.click(opener);
    await screen.findByRole('dialog', { name: 'Upload document' });
    await close(u);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('shows the empty message alone, with no pager text, for an empty list', async () => {
    const { container } = renderTab();
    await screen.findByText('No documents yet');
    expect(container.textContent).not.toMatch(/Page\s*0\s*of\s*0/);
    expect(container.textContent).not.toMatch(/Showing\s*0/);
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('shows the load error when the list fails, and one failure line when the box failed too', async () => {
    serveDocs({ listFails: true });
    renderTab();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    await screen.findByTestId('embedded-documents');
    hoisted.onLoadError?.({});
    await waitFor(() => expect(screen.getAllByText(FAILED)).toHaveLength(1));
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });
});
