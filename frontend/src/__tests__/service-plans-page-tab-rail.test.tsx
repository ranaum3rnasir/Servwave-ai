/**
 * Phase 11.6 - ServicePlansPage moves from DetailPageShell to TabStrip.
 *
 * Pins the REAL page's rendered tab-rail markup byte-exact - the plain,
 * uncustomised shape (no Card, no rail padding, no wrapper div, default
 * 'line' triggers), matching this page's pre-migration bare
 * `<Tabs><TabsList><TabsTrigger>` exactly. ServicePlansPage was already
 * DetailPageShell's `card={false}` shape with no other overrides, which is
 * TabStrip's own default render with zero surrounding JSX - the one call
 * site this migration touches with zero disclosed deviation.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import api from '@/lib/axios';

vi.mock('@/lib/api/users', () => ({ useUsers: () => ({ data: [] }) }));

import ServicePlansPage from '@/pages/service-plans/ServicePlansPage';

const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

describe('ServicePlansPage tab rail - TabStrip rendered contract', () => {
  it('renders a bare Tabs/TabsList/TabsTrigger with no Card and no rail wrapper', async () => {
    vi.mocked(api).get.mockResolvedValue({ data: { servicePlans: [] } });
    renderWithProviders(<ServicePlansPage />);

    const list = await screen.findByRole('tablist');
    expect(cls(list)).toBe('flex items-center gap-[26px] border-b border-border');

    // No wrapper div: TabsList is the Tabs root's direct child, and the Tabs root itself
    // carries no Card styling (no rounded-card, no shadow-card, no border surface classes).
    const tabsRoot = list.parentElement as HTMLElement;
    expect(cls(tabsRoot)).toBe('');
    expect(tabsRoot.className).not.toContain('rounded-card');
    expect(tabsRoot.className).not.toContain('shadow-card');

    const plansTab = screen.getByRole('tab', { name: 'Plans' });
    expect(cls(plansTab)).toBe(
      'inline-flex items-center justify-center whitespace-nowrap transition-colors ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
        'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 -mb-px ' +
        'border-b-2 border-transparent pb-2.5 text-sm font-semibold text-text-secondary ' +
        'data-[state=active]:border-primary data-[state=active]:text-text-primary'
    );

    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Plans', 'History']);
    // Initial tab is "Plans", matching the pre-conversion `defaultValue="plans"`.
    expect(plansTab).toHaveAttribute('data-state', 'active');
  });
});
