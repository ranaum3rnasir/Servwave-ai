/**
 * The page-level dismissal predicate behind SchedulePage's capturing document
 * `mousedown` listener (`../overlayDismiss`), pinned against the context-menu
 * surface that actually depends on it.
 *
 * THE BUG THIS GUARDS: a hand-positioned overlay that hosts a Radix Select. A
 * Radix Select holds `pointer-events: none` on `<body>` while its list is open,
 * so the press that dismisses that list cannot hit anything inside `<body>` -
 * the overlay included - and the browser retargets it to `<html>`. The
 * predicate read that as an outside click, dismissed the overlay, and
 * react-big-calendar's own document `mousedown` then started a fresh slot
 * selection over the freed space. (The quick-schedule card that first hit this
 * is gone - the unified creation popover replaced it - but the predicate still
 * guards the two context menus, and the retarget rule is unchanged.)
 *
 * jsdom has no layout and no hit-testing, so the two portalled cases are stood
 * in for rather than produced: the retarget is asserted by handing the predicate
 * the target a real browser hands it (`document.documentElement`), and the
 * portalled list by a `[data-radix-popper-content-wrapper]` node of the shape
 * Radix renders. The surface itself is the real component.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';

import { MenuSurface, MenuItem } from '../components/menuSurface';
import { isScheduleOverlayInteraction } from '../overlayDismiss';

function renderSurface() {
  return renderWithProviders(
    <MenuSurface style={{ left: 120, top: 140 }}>
      <MenuItem>Assign</MenuItem>
      <MenuItem danger>Remove</MenuItem>
    </MenuSurface>,
  );
}

/** A node of the shape Radix portals its open Select list into. */
function portalledList(): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-radix-popper-content-wrapper', '');
  const item = document.createElement('div');
  item.textContent = '9:30 AM';
  wrapper.appendChild(item);
  document.body.appendChild(wrapper);
  return item;
}

let strays: HTMLElement[] = [];

beforeEach(() => {
  strays = [];
});

afterEach(() => {
  strays.forEach((el) => el.remove());
});

describe('SchedulePage overlay dismissal - what counts as a press INSIDE an overlay', () => {
  it('the surface is what the predicate recognises, and every row sits inside it', () => {
    renderSurface();
    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      expect(row.closest('[data-schedule-overlay]')).not.toBeNull();
      expect(isScheduleOverlayInteraction(row)).toBe(true);
    });
  });

  it('REGRESSION: the press retargeted to the document root while a Radix list is open is NOT outside', () => {
    renderSurface();
    // What the browser hands the listener once Radix has put `pointer-events:
    // none` on <body>: the pointer is over the overlay, but nothing in <body>
    // can be hit. Treating this as an outside click closed the overlay and let
    // the calendar open a brand-new selection underneath.
    expect(isScheduleOverlayInteraction(document.documentElement)).toBe(true);
    expect(isScheduleOverlayInteraction(document.body)).toBe(true);
  });

  it('an open Radix list is inside, wherever Radix portals it', () => {
    renderSurface();
    const item = portalledList();
    strays.push(item.parentElement as HTMLElement);
    expect(isScheduleOverlayInteraction(item)).toBe(true);
  });

  it('SENSITIVITY: a press on the calendar behind the surface still dismisses it', () => {
    renderSurface();
    const slot = document.createElement('div');
    slot.className = 'rbc-day-slot';
    document.body.appendChild(slot);
    strays.push(slot);
    expect(isScheduleOverlayInteraction(slot)).toBe(false);
  });

  it('a target that is not an element dismisses too (nothing to reason about)', () => {
    expect(isScheduleOverlayInteraction(null)).toBe(false);
    expect(isScheduleOverlayInteraction(document)).toBe(false);
  });
});
