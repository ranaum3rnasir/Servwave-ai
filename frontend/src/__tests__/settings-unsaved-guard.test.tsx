/**
 * #113 — Settings unsaved-changes guard across ALL exit paths.
 *
 * Exercises the REAL store + popstate mechanism (NOT react-router's useBlocker —
 * that API is unavailable on this declarative <BrowserRouter> stack and would
 * throw; stubbing it would mask a regression). We spy on `useNavigate` (the
 * established importActual-spread pattern used across the suite), never on
 * useBlocker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { renderWithProviders, communicationSectionAbility } from './helpers';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import Header from '@/components/layout/Header';
import GlobalSearch from '@/components/layout/GlobalSearch';
import AppLayout from '@/components/layout/AppLayout';
import SettingsLayout, { useSettingsBar } from '@/pages/settings/SettingsLayout';

// Spy on navigation without touching useBlocker (which is intentionally unused).
const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => navigateSpy };
});

// The Header's comms shortcuts (Phone messages / WhatsApp / Inbox) are gated
// behind useFeature('phone') (the org's plan entitlement — real orgs otherwise
// hide them until they're on a plan that includes Communication). Render as an
// org with the `phone` feature so the AC1b comms-button guard specs can find
// and click those buttons. useIsDemoOrg stays mocked for other demo-gated
// Header children.
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  // Children of Header/AppLayout fetch org + comms counts; resolve everything benign.
  mockApi.get.mockResolvedValue({ data: {} });
  // jsdom has no layout engine — GlobalSearch scrolls the active row into view.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

// ─── EDIT 2/3/5/6 mechanism: store deferral ───────────────────────────────
describe('settingsGuard store — requestLeave deferral (#113)', () => {
  it('defers the leave when dirty and runs it on resolve', () => {
    const spy = vi.fn();
    useSettingsGuard.getState().setDirty(true);
    useSettingsGuard.getState().requestLeave(spy);

    // Dirty → the navigation is stashed behind the confirm dialog, not run.
    expect(spy).not.toHaveBeenCalled();
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();

    useSettingsGuard.getState().resolvePending();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useSettingsGuard.getState().pendingLeave).toBeNull();
  });

  it('runs the leave synchronously when clean', () => {
    const spy = vi.fn();
    useSettingsGuard.getState().setDirty(false);
    useSettingsGuard.getState().requestLeave(spy);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(useSettingsGuard.getState().pendingLeave).toBeNull();
  });
});

// ─── EDIT 2: Header comms buttons ─────────────────────────────────────────
describe('Header comms buttons — guarded (#113 AC1b)', () => {
  it('defers navigation when dirty', async () => {
    const user = userEvent.setup();
    // #2046 - the shortcut additionally needs the Communication section ability now.
    renderWithProviders(<Header />, { ability: communicationSectionAbility() });
    useSettingsGuard.getState().setDirty(true);

    await user.click(screen.getByRole('button', { name: 'Phone messages' }));

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
  });

  it('navigates immediately when clean', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Header />, { ability: communicationSectionAbility() });
    useSettingsGuard.getState().setDirty(false);

    await user.click(screen.getByRole('button', { name: 'Phone messages' }));

    expect(navigateSpy).toHaveBeenCalledWith('/communication/phone');
  });
});

// ─── EDIT 5: GlobalSearch result navigation ───────────────────────────────
describe('GlobalSearch result navigation — guarded (#113 AC1d)', () => {
  const SEARCH_RESPONSE = {
    results: {
      jobs: [
        { id: 'job-1', entity_type: 'job', title: 'J00042 — AC repair', subtitle: 'Doe HVAC' },
      ],
      customers: [],
      leads: [],
      estimates: [],
    },
  };

  it('defers navigation when dirty', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: SEARCH_RESPONSE });
    renderWithProviders(<GlobalSearch />);
    useSettingsGuard.getState().setDirty(true);

    await user.type(screen.getByRole('combobox'), 'AC');
    // The result title is highlight-split into multiple spans, so target the
    // row by its option role rather than by text.
    const row = await screen.findByRole('option');
    await user.click(row);

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
  });

  it('navigates to the result when clean', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: SEARCH_RESPONSE });
    renderWithProviders(<GlobalSearch />);
    useSettingsGuard.getState().setDirty(false);

    await user.type(screen.getByRole('combobox'), 'AC');
    const row = await screen.findByRole('option');
    await user.click(row);

    expect(navigateSpy).toHaveBeenCalledWith('/jobs/job-1');
  });
});

// ─── EDIT 6: ServWave brand logo ──────────────────────────────────────────
describe('ServWave brand logo — guarded (#113 AC1e)', () => {
  it('defers navigation when dirty (preventDefault + requestLeave)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppLayout />);
    useSettingsGuard.getState().setDirty(true);

    await user.click(screen.getByRole('link', { name: 'ServWave dashboard' }));

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
  });

  it('does not engage the dirty-gate when clean', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppLayout />);
    useSettingsGuard.getState().setDirty(false);

    await user.click(screen.getByRole('link', { name: 'ServWave dashboard' }));

    // Clean → the bare <Link> navigates normally; the guard never fired.
    expect(useSettingsGuard.getState().pendingLeave).toBeNull();
  });
});

// ─── EDIT 1: SPA Back/Forward (popstate) ──────────────────────────────────
describe('SettingsLayout popstate guard (#113 AC1c)', () => {
  // A tiny settings child that registers a dirty/clean saver, mirroring the
  // capture pattern other settings specs use.
  function DirtyChild({ dirty }: { dirty: boolean }) {
    const { registerSaver } = useSettingsBar();
    // Register in an effect (NOT during render) — the real settings pages do the
    // same; calling the registerSaver setState during render would loop forever.
    useEffect(() => {
      registerSaver({ save: () => {}, discard: () => {}, isDirty: dirty });
    }, [registerSaver, dirty]);
    return <div>settings child</div>;
  }

  function renderLayout(dirty: boolean) {
    // Local render: MemoryRouter is the REAL component (importActual spread), so
    // routing works; the popstate handler listens on the real window regardless.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/settings/company']}>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route path="company" element={<DirtyChild dirty={dirty} />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('cancels Back and prompts when dirty', async () => {
    renderLayout(true);
    await screen.findByText('settings child');
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    const pushSpy = vi.spyOn(window.history, 'pushState');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(pushSpy).toHaveBeenCalled(); // navigation cancelled — page stays put
    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    pushSpy.mockRestore();
  });

  it('does not prompt on Back when clean', async () => {
    renderLayout(false);
    await screen.findByText('settings child');
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(false));

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });
});
