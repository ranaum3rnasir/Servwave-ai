/// <reference types="@testing-library/jest-dom/vitest" />
// The reading pane header names the channel a message came through only when
// that is true. Mail the app sent by itself (account 'system') says "via
// System". Everything else the backend stores (account 'user': mail received
// in a person's own mailbox, mail a person sent) was not sent by the system,
// so the line carries the recipient and no "via" label at all.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import type { Email } from '@/lib/api/communication';
import { ReadingPane } from '@/pages/v2/communication/components/readingPane';

const RECEIVED: Email = {
  id: 'e_received_user',
  account: 'user',
  from: { name: 'Dana Customer', email: 'dana@example.com' },
  to: 'support@mail.example.com',
  subject: 'Receiving check',
  snippet: 'Hello from outside.',
  body: ['Hello from outside.'],
  at: '9:41 AM',
  ts: 1,
  unread: false,
  starred: false,
  folder: 'inbox',
  direction: 'in',
};

function renderPane(email: Email) {
  const noop = vi.fn();
  return renderWithProviders(
    <ReadingPane
      email={email}
      thread={[email]}
      reply={null}
      onReplyChange={noop}
      onSendReply={noop}
      onDiscardReply={noop}
      onPopOutReply={noop}
      onBack={noop}
      onStar={noop}
      onArchive={noop}
      onReply={noop}
      onForward={noop}
      onTrash={noop}
      onToast={noop}
      onUpdateEmail={noop}
    />,
  );
}

describe('ReadingPane "via" label', () => {
  it('mail received in a person mailbox shows its recipient and never "via System"', () => {
    renderPane(RECEIVED);

    expect(screen.getByText(/support@mail\.example\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/via/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/System/)).not.toBeInTheDocument();
  });

  it('mail the app sent by itself still says "via System"', () => {
    renderPane({ ...RECEIVED, id: 'e_sys', account: 'system', folder: 'sent', direction: 'out' });

    expect(screen.getByText(/via/)).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
  });
});
