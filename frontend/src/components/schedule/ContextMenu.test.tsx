// TG13 (D9) — the board context menu's role gating: read-only roles keep the
// open-details navigation row; the mutating affordances (edit / cancel) hide.
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ContextMenu } from '@/components/schedule/ContextMenu';
import type { BoardEvent } from '@/components/schedule/scheduleModel';
import { asWallClock } from '@/lib/schedule-tz';

const jobEvent: BoardEvent = {
  boardId: 'jv-v1', parentId: 'job-1', visitId: 'v1', type: 'job', number: 'J00041', title: 'Furnace tune-up', customer: 'Acme',
  crew: ['m1'], ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 9, 0)), end: asWallClock(new Date(2026, 5, 10, 11, 0)), raw: {},
};

function renderMenu(overrides: Partial<React.ComponentProps<typeof ContextMenu>> = {}) {
  const props = {
    event: jobEvent,
    x: 10,
    y: 10,
    onClose: vi.fn(),
    onOpenDetails: vi.fn(),
    onEdit: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  renderWithProviders(<ContextMenu {...props} />);
  return props;
}

describe('ContextMenu — D9 read-only gating (TG13)', () => {
  it('default (full edit): details + edit + cancel all render', () => {
    renderMenu();
    expect(screen.getByText('Open Job Details')).toBeInTheDocument();
    expect(screen.getByText(/Edit crew & schedule/)).toBeInTheDocument();
    expect(screen.getByText('Cancel Job')).toBeInTheDocument();
  });

  it('readOnly: edit + cancel hide; open-details stays and still fires', () => {
    const { onOpenDetails, onClose } = renderMenu({ readOnly: true });
    expect(screen.queryByText(/Edit crew & schedule/)).not.toBeInTheDocument();
    expect(screen.queryByText('Cancel Job')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Open Job Details'));
    expect(onOpenDetails).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'job-1' }));
    expect(onClose).toHaveBeenCalled();
  });
});
