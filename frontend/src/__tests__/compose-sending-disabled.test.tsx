// `GET /sending-identity` has always returned `sendingEnabled`, and nothing
// rendered it. An org whose admin switched outgoing email off therefore got a
// compose window that looked completely functional: the From row named a real,
// well-formed address (it IS real - the switch is about sending, not about the
// identity), and the user only learned otherwise after writing the whole
// message, when the send came back 409 `org_disabled`.
//
// So: warn before they type, and disable Send. The banner defaults to HIDDEN
// while the identity query is in flight - a warning shown wrongly to every user
// on every open would be worse than one shown a beat late, and the send path
// enforces the real rule either way.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ComposeWindow,
  SendingDisabledNotice,
  SENDING_DISABLED_LABEL,
} from '@/components/communication/inbox/ComposeWindow';
import type { ComposeState } from '@/lib/api/communication';

// The compose surface pulls templates/attach-sources through the seam; neither
// is what these specs are about, so they return stable empties.
vi.mock('@/lib/api/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/communication')>()),
  useTextTemplates: () => ({ data: [] }),
  useAttachSources: () => ({ data: [] }),
}));

const DRAFT: ComposeState = {
  mode: 'new',
  account: 'system',
  to: 'customer@example.com',
  subject: 'Quote',
  body: 'Here is your quote.',
};

const noop = () => {};

function renderCompose(sendingEnabled?: boolean) {
  return render(
    <ComposeWindow
      state={DRAFT}
      onChange={noop}
      onSend={onSend}
      onClose={noop}
      onDiscard={noop}
      onToast={noop}
      fromAddress="alphadoors@mail.servwave.com"
      {...(sendingEnabled === undefined ? {} : { sendingEnabled })}
    />,
  );
}

const onSend = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SendingDisabledNotice', () => {
  it('renders nothing when sending is on, so callers can mount it unconditionally', () => {
    const { container } = render(<SendingDisabledNotice sendingEnabled />);

    expect(container).toBeEmptyDOMElement();
  });

  it('states plainly that sending is off for the organization', () => {
    render(<SendingDisabledNotice sendingEnabled={false} />);

    expect(screen.getByText(new RegExp(SENDING_DISABLED_LABEL, 'i'))).toBeInTheDocument();
  });

  it('is exposed to assistive tech as a status region', () => {
    // It appears without any user action, so a sighted user sees it and a
    // screen-reader user has to be told too.
    render(<SendingDisabledNotice sendingEnabled={false} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('tells the user what to do about it, not just that it is broken', () => {
    render(<SendingDisabledNotice sendingEnabled={false} />);

    expect(screen.getByText(/ask an admin/i)).toBeInTheDocument();
  });
});

describe('ComposeWindow - sending disabled', () => {
  it('warns before a word is typed', () => {
    renderCompose(false);

    expect(screen.getByText(new RegExp(SENDING_DISABLED_LABEL, 'i'))).toBeInTheDocument();
  });

  it('disables Send', () => {
    renderCompose(false);

    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('does not fire onSend even if the disabled button is clicked', async () => {
    // The guard has to be the disabled attribute, not just a visual dimming -
    // otherwise the click still reaches the handler and still 409s.
    const user = userEvent.setup();
    renderCompose(false);

    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it('still shows the real From address, which is not what the switch turns off', () => {
    renderCompose(false);

    expect(screen.getByText('alphadoors@mail.servwave.com')).toBeInTheDocument();
  });
});

describe('ComposeWindow - sending enabled', () => {
  it('shows no banner and leaves Send usable', () => {
    renderCompose(true);

    expect(screen.queryByText(new RegExp(SENDING_DISABLED_LABEL, 'i'))).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeEnabled();
  });

  it('sends on click', async () => {
    const user = userEvent.setup();
    renderCompose(true);

    await user.click(screen.getByRole('button', { name: /send/i }));

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('defaults to enabled when the prop is omitted entirely', () => {
    // The identity query is undefined while in flight and on any plan/role that
    // cannot reach the endpoint. Neither is evidence that sending is off, so
    // neither may produce a warning.
    renderCompose(undefined);

    expect(screen.queryByText(new RegExp(SENDING_DISABLED_LABEL, 'i'))).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeEnabled();
  });
});
