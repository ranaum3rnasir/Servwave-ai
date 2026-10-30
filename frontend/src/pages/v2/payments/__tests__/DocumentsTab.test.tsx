// Payments go-live P8 - the Documents tab hosts the processor's embedded Documents component inside ServWave's tab
// frame. The component is mocked (it does not render in jsdom); everything the tab decides is real. These cases carry
// the viewer-session assertions of the retired Settings > ServWave Payments page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { resetAccountScopedStores } from '@/lib/storeReset';

import DocumentsTab from '../tabs/DocumentsTab';
import { RANGE, mockApi } from './paymentsFixtures';

const hoisted = vi.hoisted(() => ({
  load: vi.fn(),
  logout: vi.fn(),
  onLoadError: undefined as undefined | ((e: unknown) => void),
}));

vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: hoisted.load }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="connect-provider">{children}</div>,
  ConnectDocuments: ({ onLoadError }: { onLoadError?: (e: unknown) => void }) => {
    hoisted.onLoadError = onLoadError;
    return <div data-testid="embedded-documents" />;
  },
}));

const tabState = { params: new URLSearchParams('tab=documents'), setParams: vi.fn() };
const renderTab = () => renderWithProviders(<DocumentsTab range={RANGE} tabState={tabState} />);

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

  it('is not filtered by the period: it asks ServWave for nothing but the session', async () => {
    renderTab();
    await screen.findByTestId('embedded-documents');
    await libraryAsksForSecret();
    expect(mockApi.get).not.toHaveBeenCalled();
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
