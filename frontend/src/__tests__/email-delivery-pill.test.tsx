/**
 * Email slice 5 — EmailDeliveryPill, the shared render site for
 * Email.deliveryStatus / CommItem.deliveryStatus wherever a sent email's
 * delivery fact needs to show (Inbox thread, Job/Customer/Lead Communication
 * tabs, Invoice page). Routes entirely through the `messageDelivery`
 * status-registry domain + StatusBadge - this suite is the contract test for
 * that domain's tone mapping as actually rendered, not just the registry
 * table in isolation (status-registry.test.ts covers that).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmailDeliveryPill } from '@/components/communication/shared/EmailDeliveryPill';

describe('EmailDeliveryPill', () => {
  it('renders nothing when status is absent (row predates the webhook, or nothing has reported yet)', () => {
    const { container } = render(<EmailDeliveryPill status={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['QUEUED', 'Queued'],
    ['SENT', 'Sent — awaiting confirmation'],
    ['DEFERRED', 'Delivery delayed'],
    ['DELIVERED', 'Delivered'],
    ['BOUNCED', 'Bounced'],
    ['FAILED', 'Failed to send'],
    ['COMPLAINED', 'Marked as spam'],
  ])('renders the right label for %s', (status, label) => {
    render(<EmailDeliveryPill status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('never renders any text implying the message was opened', () => {
    // No EmailDeliveryStatus value means "opened" - assert directly against
    // the full set of values this component can ever be asked to render.
    const allStatuses = ['QUEUED', 'SENT', 'DEFERRED', 'DELIVERED', 'BOUNCED', 'FAILED', 'COMPLAINED'];
    for (const status of allStatuses) {
      const { unmount, container } = render(<EmailDeliveryPill status={status} />);
      expect(container.textContent).not.toMatch(/opened/i);
      unmount();
    }
  });

  it('BOUNCED never renders with a success-tone class (bg-success-surface)', () => {
    const { container } = render(<EmailDeliveryPill status="BOUNCED" />);
    expect(container.innerHTML).not.toContain('bg-success-surface');
  });

  it('FAILED never renders with a success-tone class', () => {
    const { container } = render(<EmailDeliveryPill status="FAILED" />);
    expect(container.innerHTML).not.toContain('bg-success-surface');
  });

  it('COMPLAINED never renders with a success-tone class', () => {
    const { container } = render(<EmailDeliveryPill status="COMPLAINED" />);
    expect(container.innerHTML).not.toContain('bg-success-surface');
  });

  it('only DELIVERED renders with the success-tone class', () => {
    const statuses = ['QUEUED', 'SENT', 'DEFERRED', 'DELIVERED', 'BOUNCED', 'FAILED', 'COMPLAINED'];
    for (const status of statuses) {
      const { unmount, container } = render(<EmailDeliveryPill status={status} />);
      const isSuccess = container.innerHTML.includes('bg-success-surface');
      expect(isSuccess).toBe(status === 'DELIVERED');
      unmount();
    }
  });

  it('carries the delivery_status_reason as a tooltip title when present', () => {
    const { container } = render(
      <EmailDeliveryPill status="BOUNCED" reason="550 5.1.1 mailbox unavailable" />,
    );
    expect(container.querySelector('[title="550 5.1.1 mailbox unavailable"]')).toBeInTheDocument();
  });

  it('carries no title attribute when there is no reason', () => {
    const { container } = render(<EmailDeliveryPill status="DELIVERED" />);
    expect(container.querySelector('[title]')).toBeNull();
  });
});
