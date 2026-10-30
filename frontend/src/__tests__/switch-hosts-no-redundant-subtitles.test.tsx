/**
 * Payments W2: the phone settings screens that host switches no longer print grey helper lines
 * under a toggle label. The background moves into a "?" button that opens on click.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { CallMaskingView } from '@/components/communication/phone/CallMaskingView';
import { TextingView } from '@/components/communication/phone/TextingView';

vi.mock('@/hooks/useTechs', () => ({ useTechs: () => ({ data: [] }) }), { virtual: true });

async function openMaskingSteps() {
  renderWithProviders(<CallMaskingView onToast={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /which field techs will get masked/i }));
  await userEvent.click(screen.getByRole('button', { name: /ai guardrails & insights/i }));
}

async function openCompliance() {
  renderWithProviders(<TextingView onToast={vi.fn()} />);
  await userEvent.click(await screen.findByRole('button', { name: /compliance & legal/i }));
}

describe('CallMaskingView', () => {
  it('prints no grey description under the auto-mask or AI switches', async () => {
    await openMaskingSteps();
    expect(screen.getByRole('button', { name: /more about auto-mask/i })).toBeInTheDocument();
    // The screen is on show (not collapsed), so the absences below are real.
    expect(screen.getByRole('button', { name: /more about off-platform leak guard/i })).toBeInTheDocument();
    expect(screen.queryByText(/Every new user added to the system/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Flags when a tech shares a personal number/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Every masked call is auto-transcribed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Detects an upset client/i)).not.toBeInTheDocument();
  });

  it('the background is one click away on a "?" button', async () => {
    await openMaskingSteps();
    await userEvent.click(screen.getByRole('button', { name: /more about off-platform leak guard/i }));
    expect(await screen.findByText(/Flags when a tech shares a personal number/i)).toBeInTheDocument();
  });
});

describe('Phone settings headers carry no intro sentences', () => {
  it('call masking prints no intro, AI card intro or auto-mask list line', async () => {
    await openMaskingSteps();
    expect(screen.getByRole('button', { name: /save masking rules/i })).toBeInTheDocument();
    expect(screen.queryByText(/Protect tech and customer privacy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI watches masked/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/These techs get a/i)).not.toBeInTheDocument();
  });

  it('texting prints no header sentence', async () => {
    await openCompliance();
    expect(screen.getByRole('heading', { name: 'Texting' })).toBeInTheDocument();
    expect(screen.queryByText(/Two-way SMS from your business number/i)).not.toBeInTheDocument();
  });
});

describe('the "?" button is a real tap target', () => {
  it('cannot be squeezed by a flex row and grows to 44px on touch', async () => {
    await openMaskingSteps();
    const cls = screen.getByRole('button', { name: /more about auto-mask/i }).className;
    expect(cls).toMatch(/\bshrink-0\b/);
    expect(cls).toMatch(/\bmin-w-6\b/);
    expect(cls).toMatch(/touch:size-11/);
  });
});

describe('TextingView', () => {
  it('prints no grey description under the opt-out footer or quiet hours switches', async () => {
    await openCompliance();
    expect(screen.getByRole('button', { name: /more about quiet hours/i })).toBeInTheDocument();
    expect(screen.queryByText(/Appended to marketing texts so recipients/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Holds non-urgent texts until/i)).not.toBeInTheDocument();
  });

  it('the background is one click away on a "?" button', async () => {
    await openCompliance();
    await userEvent.click(screen.getByRole('button', { name: /more about auto opt-out footer/i }));
    expect(await screen.findByText(/Appended to marketing texts so recipients/i)).toBeInTheDocument();
  });
});
