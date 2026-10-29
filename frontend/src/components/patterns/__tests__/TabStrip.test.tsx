/**
 * TabStrip - phase 11.6 rendered contract (retires DetailPageShell).
 *
 * Three things are asserted here.
 *
 * 1. COVERAGE. The `<Tabs><TabsList>{generated triggers}</TabsList>{children}
 *    </Tabs>` shape this component generates is byte-identical to
 *    ServicePlansPage's own bare, uncarded `<Tabs>` usage - the one call site
 *    that needs no wrapper at all, so it is this component's default shape
 *    with zero surrounding JSX.
 * 2. THE PROP SURFACE STAYS NARROW. `tabs`/`active`/`onChange`/`children`/
 *    `padX`/`padTop`/`listVariant`/`triggerVariant`/`triggerClassName` and
 *    nothing else - no `card`, no `tabsSurface`, no `listClassName`, no rail
 *    or content wrapper prop. This file cannot assert an absence of TS props
 *    at runtime, but it does assert that every one of the nine supported
 *    props independently reaches the DOM.
 * 3. THE LAYERING RULE. `components/patterns` is ratcheted to a directory-
 *    wide appearance ceiling of 0 - this file pins the exact class string of
 *    every element TabStrip itself creates, which is what makes "authors no
 *    appearance token" a checked fact rather than a claim in a comment.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TabStrip } from '@/components/patterns/TabStrip';

const cls = (el: Element | null) => el?.getAttribute('class') ?? '';

describe('TabStrip - default shape (ServicePlansPage: no wrapper, no overrides)', () => {
  const tabs = [
    { value: 'overview', label: 'Overview' },
    { value: 'plans', label: 'Plans' },
    { value: 'history', label: 'History' },
  ];

  it('renders a bare Tabs root - no Card, no surface, no wrapper div', () => {
    const { container } = render(
      <TabStrip tabs={tabs} active="plans" onChange={vi.fn()}>
        <div>panel</div>
      </TabStrip>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(cls(root)).toBe('');
  });

  it('generates one TabsList with default variant classes and no padding, TabsList as the root\'s direct child', () => {
    const { container } = render(
      <TabStrip tabs={tabs} active="plans" onChange={vi.fn()}>
        <div>panel</div>
      </TabStrip>
    );
    const root = container.firstElementChild as HTMLElement;
    const list = screen.getByRole('tablist');
    expect(list.parentElement).toBe(root);
    expect(cls(list)).toBe('flex items-center gap-[26px] border-b border-border');
  });

  it('generates one TabsTrigger per tab entry, in order, with its label content and default trigger classes', () => {
    render(
      <TabStrip tabs={tabs} active="plans" onChange={vi.fn()}>
        <div>panel</div>
      </TabStrip>
    );
    const triggers = screen.getAllByRole('tab');
    expect(triggers).toHaveLength(3);
    expect(triggers.map((t) => t.textContent)).toEqual(['Overview', 'Plans', 'History']);
    expect(cls(triggers[1]!)).toBe(
      'inline-flex items-center justify-center whitespace-nowrap transition-colors ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
        'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 -mb-px ' +
        'border-b-2 border-transparent pb-2.5 text-sm font-semibold text-text-secondary ' +
        'data-[state=active]:border-primary data-[state=active]:text-text-primary'
    );
  });

  it('accepts a ReactNode label, e.g. a label paired with a count badge', () => {
    render(
      <TabStrip
        tabs={[
          {
            value: 'overview',
            label: (
              <>
                Overview
                <span data-testid="count">(12)</span>
              </>
            ),
          },
        ]}
        active="overview"
        onChange={vi.fn()}
      >
        <div>panel</div>
      </TabStrip>
    );
    expect(screen.getByTestId('count')).toHaveTextContent('(12)');
  });

  it('disables a trigger when the tab entry says disabled', () => {
    render(
      <TabStrip
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'locked', label: 'Locked', disabled: true },
        ]}
        active="overview"
        onChange={vi.fn()}
      >
        <div>panel</div>
      </TabStrip>
    );
    expect(screen.getByRole('tab', { name: 'Locked' })).toBeDisabled();
  });

  it('passes children through unchanged as TabsContent panels, not restructured', () => {
    render(
      <TabStrip tabs={tabs} active="plans" onChange={vi.fn()}>
        <div role="tabpanel" data-testid="panel-a">
          Panel content stays exactly as authored, however large.
        </div>
      </TabStrip>
    );
    expect(screen.getByTestId('panel-a')).toHaveTextContent(
      'Panel content stays exactly as authored, however large.'
    );
  });

  it('renders children as the Tabs root\'s direct sibling to TabsList - no content wrapper', () => {
    const { container } = render(
      <TabStrip tabs={tabs} active="plans" onChange={vi.fn()}>
        <div data-testid="panel">panel</div>
      </TabStrip>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(screen.getByTestId('panel').parentElement).toBe(root);
  });
});

describe('TabStrip - controlled value wiring', () => {
  const tabs = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];

  it('marks the active tab active via the controlled `active` prop', () => {
    render(
      <TabStrip tabs={tabs} active="b" onChange={vi.fn()}>
        <div>panel</div>
      </TabStrip>
    );
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('data-state', 'inactive');
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('data-state', 'active');
  });

  it('calls onChange with the clicked tab\'s value', async () => {
    const onChange = vi.fn();
    render(
      <TabStrip tabs={tabs} active="a" onChange={onChange}>
        <div>panel</div>
      </TabStrip>
    );
    await userEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});

describe('TabStrip - padX/padTop/listVariant/triggerVariant/triggerClassName (InvoiceDetailPage/TasksHubPage shapes)', () => {
  const tabs = [{ value: 'line-items', label: 'Line Items' }];

  it('forwards padX/padTop to TabsList\'s own padding contract - InvoiceDetailPage\'s padX={4} padTop={2}', () => {
    render(
      <TabStrip tabs={tabs} active="line-items" onChange={vi.fn()} padX={4} padTop={2}>
        <div>panel</div>
      </TabStrip>
    );
    const list = screen.getByRole('tablist');
    expect(cls(list)).toBe('flex items-center gap-[26px] border-b border-border pt-2 pr-4 pl-4');
  });

  it('forwards triggerVariant + triggerClassName uniformly to every generated trigger - TasksHubPage\'s underline shape', () => {
    render(
      <TabStrip
        tabs={[
          { value: 'dashboard', label: 'Dashboard' },
          { value: 'board', label: 'Board' },
        ]}
        active="dashboard"
        onChange={vi.fn()}
        triggerVariant="underline"
        triggerClassName="px-4 py-3"
      >
        <div>panel</div>
      </TabStrip>
    );
    const trigger = screen.getByRole('tab', { name: 'Dashboard' });
    expect(cls(trigger)).toBe(
      'inline-flex items-center justify-center whitespace-nowrap transition-colors ' +
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
        'focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 relative ' +
        'border-b-[3px] border-transparent text-sm font-medium text-text-secondary ' +
        'hover:text-text-primary data-[state=active]:border-primary data-[state=active]:text-primary ' +
        'data-[state=active]:font-semibold px-4 py-3'
    );
  });

  it('forwards listVariant to TabsList - the "pill" rail look', () => {
    render(
      <TabStrip tabs={tabs} active="line-items" onChange={vi.fn()} listVariant="pill">
        <div>panel</div>
      </TabStrip>
    );
    const list = screen.getByRole('tablist');
    expect(cls(list)).toBe('flex items-center gap-[26px] bg-background-light');
  });
});
