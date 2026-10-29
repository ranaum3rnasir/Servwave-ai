// Mobile slice 49: call groups and call flows editable on a tablet.
//
//   - The call-group and call-flow tables scroll inside their own named box (slice 17's
//     container), so the Action column is reachable instead of being clipped by an
//     `overflow-hidden` wrapper.
//   - The call-flow editor's inspector is a bottom sheet below md (the canvas stays on screen), and
//     the right rail it always was at md and up.
//
// Everything here runs against local state and mocked API reads. Nothing saves to the phone service.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { CallGroupsView } from '../CallGroups';
import { CallFlowsView } from '../CallFlows';
import type { CallFlow, CallGroup } from '@/lib/api/communication';

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const originalMatchMedia = window.matchMedia;

/** Pretend to be below md (a phone) or not. Only the below-md query matches. */
function setBelowMd(below: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: below && query === MEDIA.belowMd,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const GROUP: CallGroup = {
  id: 'g1',
  name: 'Front desk',
  ring: 'all',
  members: [{ personId: 'p1', name: 'Dana Lee', device: 'cell' }],
  updatedAt: '2026-09-01T12:00:00.000Z',
};

const FLOW: CallFlow = {
  id: 'f1',
  name: 'Main line',
  structure: 'basic',
  record: true,
  status: 'active',
  updatedAt: '2026-09-01T12:00:00.000Z',
  hoursMode: 'always',
  openNodes: [
    { id: 'n1', type: 'greeting', message: 'Thanks for calling.' },
    { id: 'n2', type: 'forward', target: { kind: 'voicemail' } },
  ],
  closedNodes: [{ id: 'n3', type: 'voicemail', message: 'We are closed.' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
});

describe('call groups table', () => {
  it('scrolls inside its own named box, and the Action column is inside that box', () => {
    renderWithProviders(<CallGroupsView groups={[GROUP]} setGroups={vi.fn()} onToast={vi.fn()} />, { ability: ADMIN });

    const box = document.querySelector('[data-mobile-scroll-x="phone-call-groups"]') as HTMLElement | null;
    expect(box, 'the table sits in a named scroll box').not.toBeNull();
    expect(box).toHaveAttribute('role', 'region');
    expect(box).toHaveAccessibleName('Call groups table');
    expect(box).toHaveAttribute('tabindex', '0');
    // Not clipped: the box scrolls sideways rather than hiding what overflows.
    expect(box!.className).toContain('overflow-x-auto');
    expect(box!.className).not.toContain('overflow-hidden');
    // The Action column and its Delete button are in the table the box holds.
    expect(within(box!).getByRole('columnheader', { name: 'Action' })).toBeInTheDocument();
    expect(within(box!).getByRole('button', { name: 'Delete Front desk' })).toBeInTheDocument();
  });

  it('pins the Group column so the name stays in view while the rest scrolls', () => {
    renderWithProviders(<CallGroupsView groups={[GROUP]} setGroups={vi.fn()} onToast={vi.fn()} />, { ability: ADMIN });
    const box = document.querySelector('[data-mobile-scroll-x="phone-call-groups"]') as HTMLElement;
    expect(box.className).toContain('[&_tr>:first-child]:sticky');
  });
});

describe('call flows table', () => {
  function renderFlows() {
    return renderWithProviders(
      <CallFlowsView flows={[FLOW]} setFlows={vi.fn()} numbers={[]} onAssignNumbers={vi.fn()} onToast={vi.fn()} />,
      { ability: ADMIN },
    );
  }

  it('scrolls inside its own named box, and the Action column is inside that box', () => {
    renderFlows();

    const box = document.querySelector('[data-mobile-scroll-x="phone-call-flows"]') as HTMLElement | null;
    expect(box, 'the table sits in a named scroll box').not.toBeNull();
    expect(box).toHaveAttribute('role', 'region');
    expect(box).toHaveAccessibleName('Call flows table');
    expect(box!.className).toContain('overflow-x-auto');
    expect(box!.className).not.toContain('overflow-hidden');
    expect(within(box!).getByRole('columnheader', { name: 'Action' })).toBeInTheDocument();
    expect(within(box!).getByRole('button', { name: 'Edit Main line' })).toBeInTheDocument();
    expect(within(box!).getByRole('button', { name: 'Delete Main line' })).toBeInTheDocument();
  });

  it('owns its vertical scroll, because the Phone page clips the Call flows panel', () => {
    renderFlows();
    const box = document.querySelector('[data-mobile-scroll-x="phone-call-flows"]') as HTMLElement;
    let el: HTMLElement | null = box.parentElement;
    let scroller: HTMLElement | null = null;
    while (el && !scroller) {
      if (el.className.includes('overflow-y-auto')) scroller = el;
      el = el.parentElement;
    }
    expect(scroller, 'an ancestor of the table scrolls vertically').not.toBeNull();
  });
});

describe('call-flow editor inspector', () => {
  function openBuilder() {
    renderWithProviders(
      <CallFlowsView flows={[FLOW]} setFlows={vi.fn()} numbers={[]} onAssignNumbers={vi.fn()} onToast={vi.fn()} />,
      { ability: ADMIN },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit Main line' }));
  }

  it('is a right rail at md and up (unchanged)', () => {
    setBelowMd(false);
    openBuilder();

    // Basic Info shows in the rail with no dialog open.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByLabelText('Flow name')).toBeInTheDocument();
    expect(document.querySelector('aside')).not.toBeNull();
  });

  it('opens a step as a sheet below md, with the canvas still behind it', () => {
    setBelowMd(true);
    openBuilder();

    // No rail below md: the inspector is not on screen until a step is chosen.
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Incoming Call')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Thanks for calling.'));

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByLabelText('Greeting message')).toBeInTheDocument();
    // Its last field is a real, scrollable member of the sheet: the body scrolls, the sheet is capped.
    expect(sheet.className).toContain('max-h-');
    const body = within(sheet).getByLabelText('Greeting message').closest('.overflow-y-auto');
    expect(body, 'the inspector body scrolls inside the sheet').not.toBeNull();
  });

  it('offers the flow settings (name, numbers, recording) below md without selecting a step', () => {
    setBelowMd(true);
    openBuilder();

    fireEvent.click(screen.getByRole('button', { name: 'Flow settings' }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByLabelText('Flow name')).toBeInTheDocument();
    expect(within(sheet).getByText('Record & save calls in this flow')).toBeInTheDocument();
  });

  it('keeps Save flow on screen below md while the sheet is closed', () => {
    setBelowMd(true);
    openBuilder();
    expect(screen.getByRole('button', { name: /save flow/i })).toBeInTheDocument();
  });

  it('closes the sheet and returns to the canvas', () => {
    setBelowMd(true);
    openBuilder();
    fireEvent.click(screen.getByText('Thanks for calling.'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Incoming Call')).toBeInTheDocument();
  });
});
