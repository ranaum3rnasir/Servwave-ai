import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { NewTabLink } from '../new-tab-link';

const VARIANTS = ['text', 'button', 'chip', 'customer-id'] as const;

describe('NewTabLink', () => {
  it.each(VARIANTS)('%s: a real anchor that opens a new tab safely', (variant) => {
    render(
      <NewTabLink variant={variant} href="/customers/42">
        C-1042
      </NewTabLink>,
    );
    const a = screen.getByRole('link', { name: /C-1042/ });
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('/customers/42');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.getAttribute('title')).toBe('Opens in a new tab');
  });

  it('draws a decorative external-link icon and says "opens in a new tab" to screen readers', () => {
    render(<NewTabLink href="/x">Open</NewTabLink>);
    const a = screen.getByRole('link');
    const icon = a.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    const sr = a.querySelector('.sr-only');
    expect(sr?.textContent).toBe(' (opens in a new tab)');
    expect(screen.getByRole('link', { name: /Open.*opens in a new tab/ })).toBe(a);
  });

  it.each(VARIANTS)('%s: the icon is not display:block, so a link inside running prose does not break the line', (variant) => {
    render(
      <NewTabLink variant={variant} href="/x">
        Open
      </NewTabLink>,
    );
    const cls = screen.getByRole('link').querySelector('svg')!.classList;
    expect(cls.contains('inline-block')).toBe(true);
    expect(cls.contains('block')).toBe(false);
  });

  it('the chip is a pill 32px high and 44px on phones', () => {
    render(
      <NewTabLink variant="chip" href="/x">
        Chip
      </NewTabLink>,
    );
    const cls = screen.getByRole('link').classList;
    expect(cls.contains('rounded-full')).toBe(true);
    expect(cls.contains('h-8')).toBe(true);
    expect(cls.contains('max-md:h-11')).toBe(true);
  });

  it('the customer-id variant is small, bold, brand-coloured with tabular figures', () => {
    render(
      <NewTabLink variant="customer-id" href="/x">
        C-1
      </NewTabLink>,
    );
    const cls = screen.getByRole('link').classList;
    expect(cls.contains('font-semibold')).toBe(true);
    expect(cls.contains('tabular-nums')).toBe(true);
    expect(cls.contains('text-brand-emphasis')).toBe(true);
  });

  it('the button variant looks like an outline button', () => {
    render(
      <NewTabLink variant="button" href="/x">
        Create invoice
      </NewTabLink>,
    );
    expect(screen.getByRole('link').classList.contains('border')).toBe(true);
  });

  it.each(VARIANTS)('%s: a click does not reach a table row or a card row', (variant) => {
    const onRow = vi.fn();
    render(
      <table>
        <tbody>
          <tr onClick={onRow} onKeyDown={onRow}>
            <td>
              <NewTabLink variant={variant} href="/x" onClick={(e) => e.preventDefault()}>
                Go
              </NewTabLink>
            </td>
          </tr>
        </tbody>
      </table>,
    );
    const a = screen.getByRole('link');
    fireEvent.click(a);
    fireEvent.keyDown(a, { key: 'Enter' });
    expect(onRow).not.toHaveBeenCalled();
  });

  it('only Enter is kept from the row: another key still bubbles', () => {
    const onRowKey = vi.fn();
    render(
      <div onKeyDown={onRowKey}>
        <NewTabLink href="/x">Go</NewTabLink>
      </div>,
    );
    const a = screen.getByRole('link');
    fireEvent.keyDown(a, { key: 'ArrowDown' });
    expect(onRowKey).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(a, { key: 'Enter' });
    expect(onRowKey).toHaveBeenCalledTimes(1);
  });

  it('still calls the caller\'s own onClick', () => {
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(
      <NewTabLink href="/x" onClick={onClick}>
        Go
      </NewTabLink>,
    );
    fireEvent.click(screen.getByRole('link'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
