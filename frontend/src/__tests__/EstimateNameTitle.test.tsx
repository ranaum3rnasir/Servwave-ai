import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { EstimateNameTitle } from '@/features/estimate-workspace/components/EstimateNameTitle';

// Mock clipboard API (not available in JSDOM) — same shape as ContactCell.test.tsx.
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

const defaultProps = {
  estimateId: 'e0000000-0000-0000-0000-000000000001',
  leadId: 'l0000000-0000-0000-0000-000000000001',
  name: null as string | null,
  estimateNumber: 'E00123',
  canEdit: true,
};

describe('EstimateNameTitle — copy estimate number', () => {
  it('renders the estimate number with a "Copy estimate number" button next to it', () => {
    renderWithProviders(<EstimateNameTitle {...defaultProps} />);
    expect(screen.getByText('E00123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy estimate number' })).toBeInTheDocument();
  });

  it('copies the bare estimate number (not the display name) to the clipboard on click', () => {
    renderWithProviders(
      <EstimateNameTitle {...defaultProps} name="Door repair" estimateNumber="E00456" />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy estimate number' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('E00456');
  });

  describe('visual confirmation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('swaps the copy icon for a checkmark after copying, then reverts after 2 seconds', async () => {
      const { container } = renderWithProviders(<EstimateNameTitle {...defaultProps} />);
      const button = screen.getByRole('button', { name: 'Copy estimate number' });

      // Before clicking: copy icon shown, no checkmark.
      expect(container.querySelector('.lucide-copy')).toBeInTheDocument();
      expect(container.querySelector('.lucide-check')).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(button);
        // Flush the writeText().then() microtask (clipboard mock resolves on
        // the real microtask queue — fake timers only fake setTimeout/setInterval).
        await Promise.resolve();
      });

      // After clicking: checkmark shown, copy icon gone.
      expect(container.querySelector('.lucide-check')).toBeInTheDocument();
      expect(container.querySelector('.lucide-copy')).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      // After 2s: reverted back to the copy icon.
      expect(container.querySelector('.lucide-copy')).toBeInTheDocument();
      expect(container.querySelector('.lucide-check')).not.toBeInTheDocument();
    });
  });
});

// The pencil is the app's word for "edit this record's id" - it sits beside the number on
// customers, leads, jobs and invoices. The estimate header used to spend it on the NAME, and
// because an unnamed estimate displays as "Estimate <number>", the pencil appeared to belong
// to the number while editing something else entirely. The title stays click-to-edit; only
// the icon goes, so the pencil means one thing everywhere.
describe('EstimateNameTitle — the pencil belongs to the number, not the name', () => {
  it('renders no pencil icon beside the title', () => {
    const { container } = renderWithProviders(<EstimateNameTitle {...defaultProps} />);
    expect(container.querySelector('.lucide-pencil')).toBeNull();
  });

  it('still renames from a click on the title itself', () => {
    renderWithProviders(<EstimateNameTitle {...defaultProps} name="Roof replacement" />);

    fireEvent.click(screen.getByText('Roof replacement'));

    expect(screen.getByDisplayValue('Roof replacement')).toBeInTheDocument();
  });

  it('renders the number slot the page hands it, in place of the bare number', () => {
    renderWithProviders(
      <EstimateNameTitle
        {...defaultProps}
        numberSlot={<button type="button" aria-label="Edit number">E00123</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'Edit number' })).toBeInTheDocument();
  });

  it('keeps the copy affordance beside the number slot', () => {
    renderWithProviders(
      <EstimateNameTitle {...defaultProps} numberSlot={<span>E00123</span>} />,
    );

    expect(screen.getByRole('button', { name: /copy estimate number/i })).toBeInTheDocument();
  });
});
