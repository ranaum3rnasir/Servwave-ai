import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderMap(props: {
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}) {
  const { ServiceLocationMap } = await import('@/components/crm/service-location-map');
  render(<ServiceLocationMap {...props} />);
}

describe('ServiceLocationMap', () => {
  it('renders a Static Maps API image with the exact line1/city/state/zip query (no unit)', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
    await renderMap({ addressLine1: '123 Main St', city: 'Springfield', state: 'VA', zip: '22150' });

    const img = screen.queryByAltText('Service location map') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.src).toContain('https://maps.googleapis.com/maps/api/staticmap');
    expect(img!.src).toContain('key=test-key');
    // Exact query equality: nothing beyond line1, city, state, zip may be geocoded
    // (unit/line2 exclusion is structural — the component exposes no line2 prop).
    const expectedQuery = encodeURIComponent('123 Main St, Springfield, VA, 22150');
    expect(img!.src).toContain(`center=${expectedQuery}`);
    expect(img!.src).toContain(`markers=${expectedQuery}`);
  });

  it('renders nothing without an API key', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
    await renderMap({ addressLine1: '123 Main St', city: 'Springfield', state: 'VA', zip: '22150' });
    expect(screen.queryByAltText('Service location map')).toBeNull();
  });

  it('renders nothing while the address is not yet locatable (missing state)', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
    await renderMap({ addressLine1: '123 Main St', city: 'Springfield', state: '' });
    expect(screen.queryByAltText('Service location map')).toBeNull();
  });

  it('hides itself on image load failure instead of ever showing a raw error response (#865)', async () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
    await renderMap({ addressLine1: '123 Main St', city: 'Springfield', state: 'VA', zip: '22150' });

    const img = screen.getByAltText('Service location map');
    fireEvent.error(img);

    expect(screen.queryByAltText('Service location map')).toBeNull();
    // Nothing resembling Google's raw error text should ever land in the DOM.
    expect(document.body.textContent).not.toMatch(/rejected your request|not activated/i);
  });
});
