import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContactCell } from '@/components/data/ContactCell';

// Mock clipboard API (not available in JSDOM)
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

describe('ContactCell — blank cases', () => {
  it('renders nothing for null value', () => {
    const { container } = render(<ContactCell value={null} type="phone" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for undefined value', () => {
    const { container } = render(<ContactCell value={undefined} type="email" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for empty string', () => {
    const { container } = render(<ContactCell value="" type="phone" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders blank for placeholder phone (bg-import-phone: prefix)', () => {
    const { container } = render(<ContactCell value="bg-import-phone:5551234" type="phone" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders blank for placeholder email (@placeholder.local)', () => {
    const { container } = render(<ContactCell value="x@placeholder.local" type="email" />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ContactCell — real phone', () => {
  it('renders a tel: link with the RAW stored value but a formatted display (#352)', () => {
    render(<ContactCell value="617-555-1234" type="phone" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'tel:617-555-1234');
    expect(link).toHaveTextContent('(617) 555-1234');
  });

  it('formats a digits-only canonical store as (xxx) xxx-xxxx with a dial-safe raw href', () => {
    render(<ContactCell value="5551234567" type="phone" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'tel:5551234567');
    expect(link).toHaveTextContent('(555) 123-4567');
  });

  it('passes a non-phone-shaped value through unformatted', () => {
    render(<ContactCell value="ask for Bob" type="phone" />);
    expect(screen.getByRole('link')).toHaveTextContent('ask for Bob');
  });

  it('copy button has aria-label "Copy phone number"', () => {
    render(<ContactCell value="617-555-1234" type="phone" />);
    expect(screen.getByRole('button', { name: 'Copy phone number' })).toBeInTheDocument();
  });
});

describe('ContactCell — real email', () => {
  it('renders a mailto: link for a real email address', () => {
    render(<ContactCell value="john@example.com" type="email" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'mailto:john@example.com');
    expect(link).toHaveTextContent('john@example.com');
  });

  it('copy button has aria-label "Copy email address"', () => {
    render(<ContactCell value="john@example.com" type="email" />);
    expect(screen.getByRole('button', { name: 'Copy email address' })).toBeInTheDocument();
  });
});

describe('ContactCell — click isolation', () => {
  it('clicking the link stops propagation (does not call parent onClick)', () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <ContactCell value="617-555-1234" type="phone" />
      </div>
    );
    fireEvent.click(screen.getByRole('link'));
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('clicking the copy button stops propagation (does not call parent onClick)', () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <ContactCell value="617-555-1234" type="phone" />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy phone number' }));
    expect(parentClick).not.toHaveBeenCalled();
  });
});
