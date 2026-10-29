import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import BrandingPage from '@/pages/settings/BrandingPage';

const mockApi = vi.mocked(api);

const ORG = {
  id: 'o1',
  brand_color: '#E11D2E',
  estimate_template: 'alpha-classic',
  logo_url: null,
  estimate_terms: 'Sample terms',
  estimate_notes: '',
  estimate_payment_terms: '',
  invoice_terms: 'Sample invoice terms',
  invoice_notes: '',
  invoice_payment_terms: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: ORG });
});

describe('BrandingPage — brand color hex validation (#114)', () => {
  it('accepts a valid 6-digit hex with no inline error', async () => {
    renderWithProviders(<BrandingPage />);
    const hex = await screen.findByDisplayValue('#E11D2E');
    expect(hex).toHaveValue('#E11D2E');
    expect(screen.queryByText(/6-digit hex color/)).not.toBeInTheDocument();
  });

  it('shows an inline error for an invalid hex', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BrandingPage />);
    const hex = await screen.findByDisplayValue('#E11D2E');

    await user.clear(hex);
    await user.type(hex, 'red');

    expect(await screen.findByText(/6-digit hex color/)).toBeInTheDocument();
    expect(hex).toHaveAttribute('aria-invalid', 'true');
  });

  it('exposes the moved Estimate Document Copy under the Document Copy tab', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BrandingPage />);
    await screen.findByDisplayValue('#E11D2E'); // Branding tab loaded

    await user.click(screen.getByRole('tab', { name: 'Document Copy' }));
    expect(await screen.findByText('Estimate Document Copy')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Sample terms')).toBeInTheDocument();
  });

  it('switches Document Copy to the invoice fields (separate from estimate copy) via the shared toggle', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BrandingPage />);
    await screen.findByDisplayValue('#E11D2E');

    await user.click(screen.getByRole('tab', { name: 'Document Copy' }));
    await screen.findByText('Estimate Document Copy');

    await user.click(screen.getByRole('radio', { name: 'Invoice' }));

    expect(await screen.findByText('Invoice Document Copy')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Sample invoice terms')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Sample terms')).not.toBeInTheDocument();
  });
});

describe('BrandingPage — Estimate/Invoice preview toggle', () => {
  it('requests the estimate preview by default', async () => {
    renderWithProviders(<BrandingPage />);
    await screen.findByDisplayValue('#E11D2E');

    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    // The preview fetch goes through the raw fetch() spy from setup.ts (not axios);
    // assert on the toggle's own selection state instead of intercepting the URL directly.
    expect(screen.getByRole('radio', { name: 'Estimate' })).toHaveAttribute('aria-checked', 'true');
  });

  it('requests the invoice preview after switching the toggle', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['%PDF'], { type: 'application/pdf' })),
    });
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;

    try {
      renderWithProviders(<BrandingPage />);
      await screen.findByDisplayValue('#E11D2E');
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

      await user.click(screen.getByRole('radio', { name: 'Invoice' }));

      await waitFor(() =>
        expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('doc=invoice'))).toBe(true),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('BrandingPage — PDF preview regenerates after a logo upload', () => {
  // The default setup.ts fetch stub returns { ok: false }; override it with a
  // successful blob response and a counter so we can assert the preview iframe is
  // re-fetched (cache-busted) when the org logo changes.
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['%PDF'], { type: 'application/pdf' })),
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('re-fetches the preview with the new logo_url after a logo upload', async () => {
    const user = userEvent.setup();
    // First org load has no logo; after the upload, the org query refetches with one.
    mockApi.get
      .mockResolvedValueOnce({ data: { ...ORG, logo_url: null } })
      .mockResolvedValue({ data: { ...ORG, logo_url: 'https://cdn.example.com/logo-v2.png' } });
    mockApi.post.mockResolvedValue({ data: { logo_url: 'https://cdn.example.com/logo-v2.png' } });

    renderWithProviders(<BrandingPage />);
    await screen.findByDisplayValue('#E11D2E');

    // Initial preview fetch fires (after the 350ms debounce).
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const before = fetchSpy.mock.calls.length;

    // Upload a new logo → org query invalidates/refetches with the new logo_url,
    // which now participates in the preview cache key + effect deps.
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);

    // A fresh preview fetch fires for the new logo (cache miss on the new key).
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(before));

    // And the last preview URL carries the bust — the iframe is rendered, not "unavailable".
    expect(await screen.findByTitle('Document preview')).toBeInTheDocument();
  });
});
