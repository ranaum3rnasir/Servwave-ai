/**
 * #488 — Lead Activity: warn before discarding an unsaved note.
 *
 * ActivityPanel publishes a non-empty note draft into the shared
 * `useSettingsGuard` store (the same #113 guard used by Settings), and IconRail
 * — the sole host of ActivityPanel on entity-detail pages — renders the
 * note-specific confirm dialog and routes its panel-exit affordances through
 * `requestLeave`. Exercises the REAL store, no mocking of the guard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { IconRail } from '@/components/crm/IconRail';

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  // entityType LEAD triggers only the notes fetch (no timeline).
  mockApi.get.mockResolvedValue({ data: { notes: [] } });
});

async function openActivityAndType(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(screen.getByRole('button', { name: 'Activity' }));
  const textarea = await screen.findByPlaceholderText('Add a note...');
  await user.type(textarea, text);
  return textarea;
}

describe('IconRail Activity — unsaved-note guard (#488)', () => {
  it('publishes isDirty while a non-empty draft exists and clears it when emptied', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <IconRail entityType="LEAD" entityId="lead-1">
        <div />
      </IconRail>
    );

    const textarea = await openActivityAndType(user, 'test draft note');
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    await user.clear(textarea);
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(false));
  });

  it('defers a leave and shows the discard dialog; Keep editing keeps the draft', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <IconRail entityType="LEAD" entityId="lead-1">
        <div />
      </IconRail>
    );

    const textarea = await openActivityAndType(user, 'unsaved draft');
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    const spy = vi.fn();
    act(() => {
      useSettingsGuard.getState().requestLeave(spy);
    });

    // Dirty → the leave is stashed behind the dialog, not run.
    expect(spy).not.toHaveBeenCalled();
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
    expect(await screen.findByText('Discard unsaved note?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(spy).not.toHaveBeenCalled();
    expect(useSettingsGuard.getState().pendingLeave).toBeNull();
    expect(textarea).toHaveValue('unsaved draft');
  });

  it('Discard note runs the pending leave and clears it', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <IconRail entityType="LEAD" entityId="lead-1">
        <div />
      </IconRail>
    );

    await openActivityAndType(user, 'unsaved draft');
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    const spy = vi.fn();
    act(() => {
      useSettingsGuard.getState().requestLeave(spy);
    });
    expect(await screen.findByText('Discard unsaved note?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Discard note' }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(useSettingsGuard.getState().pendingLeave).toBeNull();
  });

  it('re-clicking the Activity icon while dirty defers the close and shows the dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <IconRail entityType="LEAD" entityId="lead-1">
        <div />
      </IconRail>
    );

    const textarea = await openActivityAndType(user, 'unsaved draft');
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    // Toggling the Activity icon again would close the panel — but a dirty note
    // must prompt instead of silently unmounting the draft.
    await user.click(screen.getByRole('button', { name: 'Activity' }));

    expect(await screen.findByText('Discard unsaved note?')).toBeInTheDocument();
    expect(useSettingsGuard.getState().pendingLeave).not.toBeNull();
    expect(textarea).toHaveValue('unsaved draft');
  });
});
