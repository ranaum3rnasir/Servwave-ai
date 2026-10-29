/**
 * SRVW-253: hovering an unselected tab must not read as selected.
 *
 * The bug was that ghost Button's own hover:text-foreground landed on the
 * exact colour the selected tab uses for its aria-selected="true" state, so
 * hover impersonated selection. This pins the fix at the DOM level: tabs are
 * found via getByRole('tab') + aria-selected (never by index or test id), and
 * the unselected trigger is checked to never carry the selected-state marker
 * - neither the border/text combo the selected branch applies, nor the
 * ghost variant's impersonating hover text colour.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TabStrip } from '../tabs';

describe('TabStrip selection state', () => {
  it('keeps the selected-state marker off a tab that is not selected', () => {
    render(
      <TabStrip
        tabs={[
          { value: 'active', label: 'Active' },
          { value: 'archived', label: 'Archived' },
        ]}
        value="active"
        onValueChange={vi.fn()}
      />,
    );

    const selectedTab = screen.getByRole('tab', { name: 'Active' });
    const unselectedTab = screen.getByRole('tab', { name: 'Archived' });

    expect(selectedTab).toHaveAttribute('aria-selected', 'true');
    expect(unselectedTab).toHaveAttribute('aria-selected', 'false');

    // The selected-state marker itself - matched as a whole class token so
    // the shared `focus-visible:border-brand` treatment (present on both)
    // cannot false-positive the check via substring matching.
    const selectedClasses = selectedTab.className.split(/\s+/);
    const unselectedClasses = unselectedTab.className.split(/\s+/);
    expect(selectedClasses).toContain('border-brand');
    expect(unselectedClasses).not.toContain('border-brand');

    // The ghost Button's own hover text colour is the exact one the
    // selected branch uses statically - it must not survive on an
    // unselected trigger, or hover keeps impersonating selection.
    expect(unselectedClasses).not.toContain('hover:text-foreground');
  });
});
