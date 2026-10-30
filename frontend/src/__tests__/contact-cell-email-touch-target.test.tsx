/**
 * A mail link in a list's contact cell is a touch-sized control, as the kit's link Button it replaced.
 *
 * Roles & Permissions S05.5 drew the cell's email as a bare anchor inside an inline-flex wrapper, so on a
 * phone the anchor became a flex item one text line tall (about 20 px): the mobile gate's target-size check
 * failed it on the customers list, and its truncating text sat past the screen edge at 200% text. The kit's
 * Button link carries the touch height (`touch:h-11`) and shrinks with its cell, so the mail link takes the same
 * classes (the anchor stays a real mailto link).
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders, seedMySwitches } from './helpers';
import { catalogToggle } from './support/backendSwitchCatalog';
import { ContactCell } from '@/pages/v2/_shared/contactCell';

const EMAIL = 'dana@example.test';

describe('the list contact cell mail link', () => {
  it('is a mailto link that carries the touch height and can shrink with its cell', () => {
    seedMySwitches({ [catalogToggle('Copy customer email').key]: true, [catalogToggle('View customers').key]: true });
    renderWithProviders(<ContactCell value={EMAIL} type="email" />);
    const link = screen.getByRole('link', { name: EMAIL });
    expect(link.getAttribute('href')).toBe(`mailto:${EMAIL}`);
    expect(link.className, 'the touch height of the kit link Button').toMatch(/touch:h-11/);
    expect(link.className, 'it must be able to shrink inside the cell').toMatch(/min-w-0/);
    expect(link.className, 'a flex row, as the kit Button is, so the inner text clips').toMatch(/inline-flex/);
    expect(link.querySelector('span.truncate'), 'the text clips with an ellipsis').not.toBeNull();
  });
});
