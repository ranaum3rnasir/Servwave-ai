// Email slice 9 (render hardening) - EmailBodyFrame is the replacement for
// InboxPage's old `dangerouslySetInnerHTML={{ __html: m.bodyHtml }}` render
// path: a sanitized HTML body now only ever reaches the DOM inside a
// sandboxed <iframe srcDoc>, never as a live node in the app's own React
// tree.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmailBodyFrame } from '../EmailBodyFrame';
import { EMAIL_IFRAME_SANDBOX } from '@/lib/communication/emailBodyFrame';

const TRACKING_PIXEL_URL = 'https://mail.example.com/track/open.gif?u=office-ip-123';

function getFrame(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector('iframe');
  if (!iframe) throw new Error('expected an <iframe> to render');
  return iframe;
}

describe('EmailBodyFrame', () => {
  it('renders the body inside a sandboxed iframe, never as a live DOM node', () => {
    const { container } = render(<EmailBodyFrame html="<p>Hello there.</p>" />);
    const iframe = getFrame(container);
    expect(iframe.getAttribute('sandbox')).toBe(EMAIL_IFRAME_SANDBOX);
    // No dangerouslySetInnerHTML anywhere: nothing else in the light DOM
    // carries the body's own markup.
    expect(container.querySelector('p')).toBeNull();
  });

  it('never sets allow-same-origin or allow-scripts on the sandbox attribute', () => {
    const { container } = render(<EmailBodyFrame html="<p>x</p>" />);
    const sandbox = getFrame(container).getAttribute('sandbox') ?? '';
    const flags = sandbox.split(/\s+/);
    expect(flags).not.toContain('allow-same-origin');
    expect(flags).not.toContain('allow-scripts');
  });

  it('uses srcDoc, not a live src URL', () => {
    const { container } = render(<EmailBodyFrame html="<p>x</p>" />);
    const iframe = getFrame(container);
    expect(iframe.getAttribute('src')).toBeNull();
    expect(iframe.getAttribute('srcdoc')).toContain('<p>x</p>');
  });

  it('blocks a remote image by default and reveals it only after Load images is clicked', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <EmailBodyFrame html={`<p>See attached.</p><img src="${TRACKING_PIXEL_URL}" alt="logo" />`} />,
    );

    expect(getFrame(container).getAttribute('srcdoc')).not.toContain(TRACKING_PIXEL_URL);

    await user.click(screen.getByRole('button', { name: /load images/i }));

    expect(getFrame(container).getAttribute('srcdoc')).toContain(TRACKING_PIXEL_URL);
  });

  it('does not render a "Load images" affordance for a body with no images', () => {
    render(<EmailBodyFrame html="<p>Just text, nothing to block.</p>" />);
    expect(screen.queryByRole('button', { name: /load images/i })).toBeNull();
  });

  it('renders a script tag in srcdoc verbatim without adding a live <script> to the light DOM', () => {
    // KNOWN GAP, read before trusting this test: vitest's `environment:
    // 'jsdom'` (frontend/vitest.config.ts) does not execute <script> content
    // inside an iframe's srcdoc AT ALL, regardless of the sandbox attribute
    // - a throwaway probe with no `sandbox` attribute whatsoever and the same
    // script body was confirmed to leave `window.__pwned` just as undefined
    // as this test does. So the `__pwned` assertion below is NOT evidence
    // that EMAIL_IFRAME_SANDBOX (or any sandbox value, including
    // "allow-scripts") blocks execution - it would pass identically if the
    // sandbox attribute were deleted. It only proves two real, narrower
    // things: (1) the light DOM never gains a live <script> node (no
    // dangerouslySetInnerHTML path), and (2) the raw tag reaches the iframe's
    // srcdoc unstripped, which is intentional (this component is not a
    // re-sanitizer). The actual "does the sandbox stop execution in a real
    // browser" property has no automated coverage in this repo today - it
    // rests on browser sandbox semantics, verified by hand, not by CI.
    const before = document.querySelectorAll('script').length;
    const { container } = render(
      <EmailBodyFrame html="<p>hi</p><script>window.__pwned = true;</script>" />,
    );
    expect(document.querySelectorAll('script').length).toBe(before);
    expect(getFrame(container).getAttribute('srcdoc')).toContain('<script>');
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });
});
