/**
 * Mobile slice 56: the activity side rail on a phone.
 *
 * Below md the rail reserves no width, its trigger lives in the detail header's overflow menu, and
 * its panel is an overlay sheet (focus trapped, Escape closes). From md up it keeps its column, the
 * closed panel is out of the tab order, and the panel starts under the REAL top bar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { IconRail } from '@/components/crm/IconRail';
import { DetailHeader } from '@/components/detail/DetailHeader';
import { MEDIA } from '@/ui-kit/lib/breakpoints';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
const originalMatchMedia = window.matchMedia;

/** Pretend to be a phone (below sm and below md both match) or anything wider. */
function setPhone(isPhone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: isPhone && (query === MEDIA.belowSm || query === MEDIA.belowMd),
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

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  mockApi.get.mockResolvedValue({ data: { notes: [] } });
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  document.querySelectorAll('[data-slot="topbar"]').forEach((el) => el.remove());
});

function renderRail(panels: Array<'activity' | 'attachments'> = ['activity']) {
  return renderWithProviders(
    <IconRail entityType="JOB" entityId="job-1" panels={panels}>
      <div data-testid="page-content">
        <DetailHeader backTo="/jobs" backLabel="Back to jobs" identity={<span>J00001</span>} secondary={[]} />
      </div>
    </IconRail>,
  );
}

describe('side rail on a phone (below md)', () => {
  beforeEach(() => setPhone(true));

  it('reserves no width and renders no rail column', () => {
    renderRail();
    const content = screen.getByTestId('page-content');
    expect(content.parentElement!.style.marginRight).toBe('');
    expect(screen.queryByTestId('icon-rail')).toBeNull();
    // The old rail button is gone from the page; the trigger is in the header menu instead.
    expect(screen.queryByTitle('Activity')).toBeNull();
  });

  it('puts the trigger in the header overflow menu and opens the panel as a dialog sheet', async () => {
    const user = userEvent.setup();
    renderRail();

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Activity' }));

    const sheet = await screen.findByRole('dialog', { name: 'Activity' });
    expect(sheet).toHaveAttribute('data-presentation', 'fullscreen');
    // Focus is moved inside the sheet (and Radix traps it there).
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    expect(await within(sheet).findByPlaceholderText('Add a note...')).toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the header menu button', async () => {
    const user = userEvent.setup();
    renderRail();

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Activity' }));
    await screen.findByRole('dialog', { name: 'Activity' });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Activity' })).toBeNull());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actions' })).toHaveFocus());
  });

  it('keeps the unsaved-note guard: Escape with a draft asks before discarding', async () => {
    const user = userEvent.setup();
    renderRail();

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Activity' }));
    const note = await screen.findByPlaceholderText('Add a note...');
    await user.type(note, 'half a note');
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    await user.keyboard('{Escape}');
    expect(await screen.findByText('Discard unsaved note?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByPlaceholderText('Add a note...')).toHaveValue('half a note');
  });

  it('lists every panel the page asked for', async () => {
    const user = userEvent.setup();
    renderRail(['activity', 'attachments']);

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Attachments' })).toBeInTheDocument();
  });
});

describe('side rail from md up', () => {
  beforeEach(() => setPhone(false));

  it('keeps its 40 px column and its button, and adds nothing to the header menu', () => {
    renderRail();
    const content = screen.getByTestId('page-content');
    expect(content.parentElement!.style.marginRight).toBe('40px');
    expect(screen.getByTitle('Activity')).toBeInTheDocument();
    // No secondary actions and no rail entries: the header has no menu at all.
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
  });

  it('takes a closed panel out of the tab order and the accessibility tree', () => {
    renderRail();
    const panel = screen.getByTestId('icon-rail-panel');
    expect(panel).toHaveAttribute('inert');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
  });

  it('opens in place with the rail button and is no longer inert', async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(screen.getByTitle('Activity'));
    const panel = screen.getByTestId('icon-rail-panel');
    expect(panel).not.toHaveAttribute('inert');
    expect(await within(panel).findByPlaceholderText('Add a note...')).toBeInTheDocument();
  });

  it('is offset by the measured top bar, not a fixed number', () => {
    const bar = document.createElement('header');
    bar.setAttribute('data-slot', 'topbar');
    bar.getBoundingClientRect = () => ({ bottom: 57, top: 0, left: 0, right: 0, width: 0, height: 57, x: 0, y: 0, toJSON: () => ({}) });
    document.body.appendChild(bar);

    renderRail();
    expect(screen.getByTestId('icon-rail').style.top).toBe('57px');
    expect(screen.getByTestId('icon-rail-panel').style.top).toBe('57px');
  });
});
