/**
 * EstimateStatusMenu - the status pill's dropdown.
 *
 * Estimate status is UNORDERED (Spec B1): every status is reachable from every other, so the
 * contract worth guarding is that this control renders exactly what the page tells it to and
 * invents nothing. Reachability lives in the page's `targets` map and in the backend, not here.
 *
 * PENDING used to be permanently unselectable, because a staff-set PENDING left signature_data
 * null while approvePublic treated PENDING as already-signed - letting an estimate reach WON
 * unsigned. approvePublic now keys that branch on the signature actually on file, so the
 * transition is safe and IS offered. The test below pins the new rule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { EstimateStatusMenu } from '@/pages/v2/estimates/components/statusMenu';

const onDraft = vi.fn();
const onPending = vi.fn();
const onSent = vi.fn();
const onWon = vi.fn();
const onDeclined = vi.fn();
const onArchived = vi.fn();

/** The target map a SENT estimate produces for a full-access user. */
const sentTargets = {
  DRAFT: { enabled: true, onSelect: onDraft },
  SENT: { enabled: true, onSelect: onSent },
  PENDING: { enabled: true, onSelect: onPending },
  WON: { enabled: true, onSelect: onWon },
  DECLINED: { enabled: true, onSelect: onDeclined },
  ARCHIVED: { enabled: true, onSelect: onArchived },
};

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /change status/i }));
};

const row = (name: RegExp) => screen.getByRole('menuitem', { name });

// Radix renders menu items as divs, so they carry aria-disabled rather than the `disabled`
// attribute `toBeDisabled()` looks for.
const expectDisabled = (el: HTMLElement) => expect(el).toHaveAttribute('aria-disabled', 'true');
const expectEnabled = (el: HTMLElement) => expect(el).not.toHaveAttribute('aria-disabled', 'true');

beforeEach(() => vi.clearAllMocks());

describe('reachability', () => {
  it('lists every status, with the current one marked and inert', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateStatusMenu status="SENT" targets={sentTargets} />);
    await openMenu(user);

    expect(screen.getAllByRole('menuitem')).toHaveLength(6);
    expectDisabled(row(/current/i));
  });

  // The transition from the original report: a SENT estimate could not be moved to
  // "Approved - Deposit Pending". It is offered now, and selecting it fires the page's handler.
  it('offers Pending and fires its handler', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateStatusMenu status="SENT" targets={sentTargets} />);
    await openMenu(user);

    const pending = row(/pending/i);
    expectEnabled(pending);
    await user.click(pending);
    expect(onPending).toHaveBeenCalledTimes(1);
  });

  it('offers the transitions a sent estimate can actually make', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateStatusMenu status="SENT" targets={sentTargets} />);
    await openMenu(user);

    expectEnabled(row(/draft/i));
    expectEnabled(row(/won/i));
    expectEnabled(row(/declined/i));
    expectEnabled(row(/archived/i));
  });

  it('fires the handler the page supplied for the chosen target', async () => {
    const user = userEvent.setup();
    renderWithProviders(<EstimateStatusMenu status="SENT" targets={sentTargets} />);
    await openMenu(user);
    await user.click(row(/won/i));

    expect(onWon).toHaveBeenCalledTimes(1);
    expect(onDraft).not.toHaveBeenCalled();
  });

  it('disables a target the user lacks permission for, and does not fire it', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateStatusMenu
        status="SENT"
        targets={{
          ...sentTargets,
          WON: { enabled: false, reason: 'You do not have permission to approve estimates', onSelect: onWon },
        }}
      />,
    );
    await openMenu(user);

    const won = row(/won/i);
    expectDisabled(won);
    await user.click(won);
    expect(onWon).not.toHaveBeenCalled();
  });

  // Under Spec B1 a DRAFT estimate is not stuck at the front of a pipeline: every other status is
  // offered. Only permission and the money guard can disable a row, and neither applies here.
  it('offers every other status from Draft', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateStatusMenu
        status="DRAFT"
        targets={{
          // The page always supplies all six; the fixture does too, so these assertions do not
          // depend on the current-status branch short-circuiting a missing key.
          DRAFT: { enabled: true, onSelect: onDraft },
          SENT: { enabled: true, onSelect: onSent },
          PENDING: { enabled: true, onSelect: onPending },
          WON: { enabled: true, onSelect: onWon },
          DECLINED: { enabled: true, onSelect: onDeclined },
          ARCHIVED: { enabled: true, onSelect: onArchived },
        }}
      />,
    );
    await openMenu(user);

    expectEnabled(row(/sent/i));
    expectEnabled(row(/archived/i));
    expectEnabled(row(/won/i));
    expectEnabled(row(/declined/i));
    expectEnabled(row(/pending/i));
  });

  // The one rule that still disables a row, and it explains itself rather than vanishing.
  it('disables a target blocked by the money trail, with the reason attached', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateStatusMenu
        status="WON"
        targets={{
          ...sentTargets,
          DRAFT: { enabled: false, reason: 'The deposit has payments recorded', onSelect: onDraft },
        }}
      />,
    );
    await openMenu(user);

    const draft = row(/draft/i);
    expectDisabled(draft);
    expect(draft).toHaveAttribute('title', 'The deposit has payments recorded');
    await user.click(draft);
    expect(onDraft).not.toHaveBeenCalled();
  });

  // `reason` explains a refusal, so it belongs only on a row that refuses. The page passes one to
  // every target regardless (it cannot know which will be disabled until it has computed both), and
  // this component used to render it unconditionally - so on staging every legal row hovered as
  // "You do not have permission to change this estimate" while doing exactly what it advertised.
  it('attaches no tooltip to a row that is actually selectable', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EstimateStatusMenu
        status="SENT"
        targets={{
          ...sentTargets,
          // Enabled, yet carrying a reason - exactly the shape the page produces, and the shape
          // that used to render a refusal tooltip on a row that refuses nothing.
          WON: { enabled: true, reason: 'You do not have permission to change this estimate', onSelect: onWon },
        }}
      />,
    );
    await openMenu(user);

    const won = row(/won/i);
    expectEnabled(won);
    expect(won).not.toHaveAttribute('title');
  });
});

describe('read-only', () => {
  // No status is terminal any more, so the only thing that makes the pill inert is having no
  // permission to change it at all.
  it('renders a plain pill with no dropdown when the user cannot change status', () => {
    renderWithProviders(<EstimateStatusMenu status="WON" readOnly targets={sentTargets} />);
    expect(screen.queryByRole('button', { name: /change status/i })).not.toBeInTheDocument();
    expect(screen.getByText(/won/i)).toBeInTheDocument();
  });
});
