/**
 * The v2 board context menu - the port of
 * `src/components/schedule/ContextMenu.test.tsx` onto the rebuilt component at
 * `pages/v2/schedule/components/contextMenu.tsx`.
 *
 * The rows became kit Buttons and the surface became `MenuSurface`, but the
 * menu stays hand-positioned: it opens at raw viewport coordinates from a
 * `contextmenu` event and the PAGE owns its dismissal. Two things therefore
 * have to survive the rebuild and neither is visible by eye - the read-only
 * gating the legacy suite pinned, and the viewport clamp plus the class pair
 * the page's outside-click listener matches on.
 */
import { asWallClock } from '@/lib/schedule-tz';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import type { BoardEvent } from '@/components/schedule/scheduleModel';

import { ContextMenu } from '../components/contextMenu';

const jobEvent: BoardEvent = {
  boardId: 'job-1', parentId: 'job-1', type: 'job', number: 'J00041', title: 'Furnace tune-up', customer: 'Acme',
  crew: ['m1'], ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 9, 0)), end: asWallClock(new Date(2026, 5, 10, 11, 0)), raw: {},
};

const walkthroughEvent: BoardEvent = {
  ...jobEvent,
  boardId: 'wt-lead-1', parentId: 'lead-1', type: 'walkthrough', number: 'L00012', title: 'Walkthrough', raw: { id: 'lead-1' },
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
  const { container } = renderWithProviders(<ContextMenu {...props} />);
  return { ...props, container };
}

describe('v2 ContextMenu - read-only gating', () => {
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
    expect(onOpenDetails).toHaveBeenCalledWith(expect.objectContaining({ boardId: 'job-1' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('the edit row is omitted when the page passes no onEdit; cancel still renders', () => {
    renderMenu({ onEdit: undefined });
    expect(screen.queryByText(/Edit crew & schedule/)).not.toBeInTheDocument();
    expect(screen.getByText('Cancel Job')).toBeInTheDocument();
  });

  it('a walkthrough relabels both rows (Open Lead / Cancel Walkthrough)', () => {
    const { onCancel, onClose } = renderMenu({ event: walkthroughEvent });
    expect(screen.getByText('Open Lead')).toBeInTheDocument();
    expect(screen.getByText('Cancel Walkthrough')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cancel Walkthrough'));
    expect(onCancel).toHaveBeenCalledWith(expect.objectContaining({ boardId: 'wt-lead-1' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('edit fires with the event and closes the menu', () => {
    const { onEdit, onClose } = renderMenu();
    fireEvent.click(screen.getByText(/Edit crew & schedule/));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ boardId: 'job-1' }));
    expect(onClose).toHaveBeenCalled();
  });

  // The menu has no trigger element to anchor to, so it clamps itself. The two
  // constants are the clamp the e2e position assertions ride on; jsdom's
  // viewport is 1024x768.
  it('clamps to the viewport rather than opening off-screen', () => {
    const { container } = renderMenu({ x: 5000, y: 5000 });
    const surface = container.querySelector('.fixed') as HTMLElement;
    expect(surface).not.toBeNull();
    expect(surface.style.left).toBe(`${window.innerWidth - 208 - 8}px`);
    expect(surface.style.top).toBe(`${window.innerHeight - 112 - 8}px`);
  });

  it('opens at the raw coordinates when they fit', () => {
    const { container } = renderMenu({ x: 10, y: 10 });
    const surface = container.querySelector('.fixed') as HTMLElement;
    expect(surface.style.left).toBe('10px');
    expect(surface.style.top).toBe('10px');
  });

  /**
   * SchedulePage's outside-click dismissal skips any target inside
   * `[data-schedule-overlay]`. That listener is on `mousedown`, and the menu's
   * own `stopPropagation` is on `click`, so the attribute is the ONLY thing
   * keeping a mousedown inside the menu from dismissing it before the click
   * lands.
   *
   * The selector used to be `[class*="fixed"][class*="z-["]` - a match on the
   * spelling of two Tailwind utilities rather than on anything true about the
   * element - and renaming the z-index utility to a named layer silently broke
   * it. This test caught that, which is exactly its job; it now guards the
   * attribute, which no restyling can rename out from under it.
   */
  it('the surface carries the page\'s "click landed inside an overlay" marker', () => {
    const { container } = renderMenu();
    const inside = screen.getByText('Open Job Details');
    expect(inside.closest('[data-schedule-overlay]')).not.toBeNull();
    expect(container.querySelector('[data-schedule-overlay]')).not.toBeNull();
  });
});
