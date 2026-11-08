/// <reference types="@testing-library/jest-dom/vitest" />
// #2251 - the reading pane's attachment chip must never invent a file.
//
// A row that says `hasAttachment` but carries no attachment list used to fall
// back to a HARDCODED `{ name: 'invoice.pdf', size: '84 KB' }` chip. Once sent
// estimates started recording has_attachment = true, any such row - an older
// send, or one whose stored copy failed to upload - would have shown an
// estimate email carrying "invoice.pdf · 84 KB": a filename and a size nobody
// sent. The honest rendering is a generic chip that says a file was attached
// and nothing it cannot back up.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import type { Email } from '@/lib/api/communication';
import { ReadingPane } from '@/pages/v2/communication/components/readingPane';

const SENT_ESTIMATE: Email = {
  id: 'e_sent_estimate',
  account: 'system',
  from: { name: 'Acme Plumbing', email: 'noreply@mail.example.com' },
  to: 'jane@example.com',
  subject: 'Estimate E00001 from Acme Plumbing',
  snippet: 'Hi Jane, your estimate E00001 is ready.',
  body: ['Hi Jane, your estimate E00001 is ready.'],
  at: '9:41 AM',
  ts: 1,
  unread: false,
  starred: false,
  folder: 'sent',
  direction: 'out',
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

describe('ReadingPane attachment chip (#2251)', () => {
  it('hasAttachment with no attachment list renders a generic chip, never a fabricated name or size', () => {
    renderPane({ ...SENT_ESTIMATE, hasAttachment: true });

    expect(screen.queryByText(/invoice\.pdf/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/84 KB/)).not.toBeInTheDocument();
    // Still says SOMETHING was attached - the row's claim is true, only the
    // details are unknown.
    expect(screen.getByTestId('email-attachment-generic')).toHaveTextContent(/^Attachment$/);
  });

  it('an empty attachment list with hasAttachment still renders the generic chip, not nothing', () => {
    renderPane({ ...SENT_ESTIMATE, hasAttachment: true, attachments: [] });

    expect(screen.queryByText(/invoice\.pdf/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('email-attachment-generic')).toBeInTheDocument();
  });

  it('real attachment rows render their own name and size, and no generic chip', () => {
    renderPane({
      ...SENT_ESTIMATE,
      hasAttachment: true,
      attachments: [{ name: 'estimate-E00001.pdf', size: '70 KB' }],
    });

    expect(screen.getByText('estimate-E00001.pdf')).toBeInTheDocument();
    expect(screen.getByText(/70 KB/)).toBeInTheDocument();
    expect(screen.queryByText(/invoice\.pdf/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('email-attachment-generic')).not.toBeInTheDocument();
  });

  it('no attachment at all renders no chip', () => {
    renderPane({ ...SENT_ESTIMATE, hasAttachment: false });

    expect(screen.queryByTestId('email-attachment-generic')).not.toBeInTheDocument();
    expect(screen.queryByText(/invoice\.pdf/i)).not.toBeInTheDocument();
  });
});
