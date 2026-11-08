// Email slice 9 (render hardening) - EmailMessageBody sits between InboxPage
// and EmailBodyFrame / the plain-paragraph render. Its one added job over
// the old inline block: an INBOUND message's quoted history (detected by
// emailQuoteSplit) is hidden by default behind a "Show trimmed content"
// toggle, mirroring InlineComposer's existing "···" quote-toggle pattern.
// We write quoted text on reply but never stripped it from a received body
// before this slice - this is that strip, scoped to direction === "in" only.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailMessageBody } from '../EmailMessageBody';

const QUOTED_HTML_BODY =
  '<p>Sounds good, see you then.</p>' +
  '<p>On Aug 3, 2026, at 9:00 AM, John Doe &lt;john@example.com&gt; wrote:</p>' +
  '<blockquote><p>Can you check on the invoice status?</p></blockquote>';

const QUOTED_TEXT_BODY = [
  'Sounds good, see you then.',
  'On Aug 3, 2026, at 9:00 AM, John Doe <john@example.com> wrote:\n\n> Can you check on the invoice status?',
];

describe('EmailMessageBody - HTML body, inbound', () => {
  it('hides the quoted history by default and reveals it via "Show trimmed content"', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <EmailMessageBody bodyHtml={QUOTED_HTML_BODY} body={[]} direction="in" />,
    );

    // Both the visible and (once revealed) quoted halves render inside
    // sandboxed iframes - their content lives in the srcDoc attribute
    // string, not as light-DOM text nodes, so assert on that directly
    // rather than screen.getByText.
    const srcDocsBefore = Array.from(container.querySelectorAll('iframe')).map((f) =>
      f.getAttribute('srcdoc'),
    );
    expect(srcDocsBefore.some((s) => s?.includes('Sounds good, see you then'))).toBe(true);
    expect(srcDocsBefore.some((s) => s?.includes('invoice status'))).toBe(false);

    await user.click(screen.getByRole('button', { name: /show trimmed content/i }));

    const srcDocsAfter = Array.from(container.querySelectorAll('iframe')).map((f) =>
      f.getAttribute('srcdoc'),
    );
    expect(srcDocsAfter.some((s) => s?.includes('invoice status'))).toBe(true);
  });

  it('does not render a trim toggle when there is no quoted history', () => {
    render(<EmailMessageBody bodyHtml="<p>Just a note, nothing quoted.</p>" body={[]} direction="in" />);
    expect(screen.queryByRole('button', { name: /show trimmed content/i })).toBeNull();
  });
});

describe('EmailMessageBody - HTML body, outbound', () => {
  it('never trims a message ServWave itself sent, even if it looks quote-shaped', () => {
    render(<EmailMessageBody bodyHtml={QUOTED_HTML_BODY} body={[]} direction="out" />);
    expect(screen.queryByRole('button', { name: /show trimmed content/i })).toBeNull();
    const iframe = document.querySelector('iframe');
    expect(iframe?.getAttribute('srcdoc')).toContain('invoice status');
  });
});

describe('EmailMessageBody - plain-text body, inbound', () => {
  it('hides the quoted paragraphs by default and reveals them via the toggle', async () => {
    const user = userEvent.setup();
    render(<EmailMessageBody body={QUOTED_TEXT_BODY} direction="in" />);

    expect(screen.getByText(/sounds good, see you then/i)).toBeInTheDocument();
    expect(screen.queryByText(/invoice status/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: /show trimmed content/i }));

    expect(screen.getByText(/invoice status/i)).toBeInTheDocument();
  });
});

describe('EmailMessageBody - no bodyHtml at all (existing plain-text path)', () => {
  it('renders no iframe anywhere - the plain-text render path is untouched', () => {
    const { container } = render(
      <EmailMessageBody body={['Just a plain message, no HTML.']} direction="out" />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText(/just a plain message, no html/i)).toBeInTheDocument();
  });

  it('is inert for a plain body with no direction at all (a prototype/seed row)', () => {
    const { container } = render(<EmailMessageBody body={['Hello, just checking in.']} />);
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.queryByRole('button', { name: /show trimmed content/i })).toBeNull();
    expect(screen.getByText(/hello, just checking in/i)).toBeInTheDocument();
  });
});
