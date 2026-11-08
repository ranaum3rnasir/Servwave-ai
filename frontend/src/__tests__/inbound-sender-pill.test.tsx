/**
 * Email slice 6 - InboundSenderPill, the shared render site for a RECEIVED
 * email's sender verdict. Routes through the `inboundSender` status-registry
 * domain + StatusBadge, mirroring EmailDeliveryPill on the outbound side.
 *
 * The load-bearing test in here is the "does not claim verified" one. A reply
 * address is a bearer token, so three genuinely different things can be true of
 * an inbound sender, and the entire reason this component exists is that they
 * must not read alike:
 *
 *   PASS                    the From domain was cryptographically established
 *   NO_POLICY / UNAVAILABLE the address matched a stored string, nothing more
 *   FAIL                    the From was forged
 *
 * Painting the middle case as verified is the same dishonesty slice 5 removed
 * from the outbound pill, and this suite is what stops it coming back.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InboundSenderPill } from '@/components/communication/shared/InboundSenderPill';

const ALL_VERDICTS = ['PASS', 'FAIL', 'NO_POLICY', 'UNAVAILABLE'];

describe('InboundSenderPill', () => {
  it('renders nothing on an outbound row, which has no verdict', () => {
    const { container } = render(<InboundSenderPill verdict={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['PASS', 'Verified sender'],
    ['FAIL', 'Failed verification'],
    ['NO_POLICY', 'Unverified - no DMARC on sender domain'],
    ['UNAVAILABLE', 'Unverified - no sender check available'],
  ])('renders the right label for %s', (verdict, label) => {
    render(<InboundSenderPill verdict={verdict} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('only ever calls PASS verified', () => {
    // The whole premise: an address that merely matched a stored string is not
    // a verified sender, and must not be worded as one.
    for (const verdict of ALL_VERDICTS.filter((v) => v !== 'PASS')) {
      const { unmount, container } = render(<InboundSenderPill verdict={verdict} />);
      expect(container.textContent).not.toMatch(/^verified/i);
      expect(container.textContent).toMatch(/unverified|failed/i);
      unmount();
    }
  });

  it('says out loud what is missing, rather than staying silent about it', () => {
    // A blank pill would be indistinguishable from a verified one at a glance.
    for (const verdict of ['NO_POLICY', 'UNAVAILABLE']) {
      const { unmount, container } = render(<InboundSenderPill verdict={verdict} />);
      expect(container.textContent?.trim()).not.toBe('');
      unmount();
    }
  });

  it('explains a forged sender differently once it has been linked by hand', () => {
    // An operator overrode the refusal. The verdict does not change, but the
    // operator story does, and the tooltip has to reflect which happened.
    const { container: refused } = render(
      <InboundSenderPill verdict="FAIL" match="UNMATCHED_SENDER" />,
    );
    const { container: linked } = render(
      <InboundSenderPill verdict="FAIL" match="MATCHED" />,
    );

    const refusedTip = refused.querySelector('[title]')?.getAttribute('title');
    const linkedTip = linked.querySelector('[title]')?.getAttribute('title');
    expect(refusedTip).toMatch(/not attached/i);
    expect(linkedTip).toMatch(/by hand/i);
  });

  it('carries an explanation on every verdict it renders', () => {
    for (const verdict of ALL_VERDICTS) {
      const { unmount, container } = render(<InboundSenderPill verdict={verdict} />);
      expect(container.querySelector('[title]')?.getAttribute('title')).toBeTruthy();
      unmount();
    }
  });
});
