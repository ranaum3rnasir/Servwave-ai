import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import SettingsLayout, { useSettingsBar } from '@/pages/settings/SettingsLayout';

// #112 — SettingsLayout.handleSave must surface a toast when a saver throws a
// client-side ValidationError (e.g. Branding's invalid brand-color hex), which has
// no mutation onError toast of its own and would otherwise be swallowed. Network /
// mutation errors (which DO toast their own detail) must NOT be re-toasted here.

const { mockToast } = vi.hoisted(() => ({ mockToast: vi.fn() }));
vi.mock('@/components/ui/use-toast', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/use-toast')>(
    '@/components/ui/use-toast'
  );
  return { ...actual, toast: mockToast };
});

const allowAll = buildAbility([{ action: 'manage', subject: 'all' }]);

/** A child settings page that registers a dirty saver throwing the given error. */
function ThrowingPage({ error }: { error: Error }) {
  const { registerSaver } = useSettingsBar();
  useEffect(() => {
    registerSaver({
      save: () => {
        throw error;
      },
      discard: () => {},
      isDirty: true,
    });
  }, [registerSaver, error]);
  return <div>child</div>;
}

function renderLayout(error: Error) {
  return render(
    <AbilityProvider ability={allowAll}>
      <MemoryRouter initialEntries={['/settings/branding']}>
        <Routes>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route path="branding" element={<ThrowingPage error={error} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AbilityProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('SettingsLayout — Save surfaces validation failures (#112)', () => {
  it('toasts (destructive) when the saver throws a ValidationError, instead of swallowing it', async () => {
    const user = userEvent.setup();
    const valErr = new Error('Brand color must be a 6-digit hex, e.g. #0C2D3A');
    valErr.name = 'ValidationError';
    renderLayout(valErr);

    await user.click(await screen.findByRole('button', { name: 'Save Changes' }));

    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        description: 'Brand color must be a 6-digit hex, e.g. #0C2D3A',
      })
    );
    // No success toast.
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Settings saved' })
    );
  });

  it('does NOT toast for a non-validation (mutation/network) error — those toast their own detail', async () => {
    const user = userEvent.setup();
    renderLayout(new Error('Network error'));

    await user.click(await screen.findByRole('button', { name: 'Save Changes' }));

    // handleSave stays silent so the mutation's own onError toast is the single source.
    expect(mockToast).not.toHaveBeenCalled();
  });
});
