/**
 * Roles & Permissions, PRD 2, S02.4 - the shared switch-set editor: groups collapse and rows stack on a phone.
 *
 * Rendered through the editor's public interface (catalog, values, editable, onChange). Which switches a group holds,
 * and which are on, are read from the catalog fixture and the preset, never written into the test. jsdom applies no
 * CSS, so how a row stacks is checked through the classes that carry it, and the order its label and control come in.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import SwitchSetEditor from '@/components/permissions/SwitchSetEditor';
import { unmetRequirement } from '@/lib/api/permissionSwitches';
import { type SwitchSet } from '@/lib/api/shared/switchTypes';
import { FIXTURE_CATALOG, FIXTURE_LAYOUT, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

function draw(values: SwitchSet = presetSet('DISPATCHER'), editable = true) {
  return render(
    <TooltipProvider>
      <SwitchSetEditor catalog={FIXTURE_CATALOG} values={values} editable={editable} onChange={() => {}} />
    </TooltipProvider>,
  );
}

/** The toggle switches a group of the layout holds, whichever row or nesting they sit in. */
function toggleKeysOf(groupLabel: string): string[] {
  const group = FIXTURE_LAYOUT.groups.find((g) => g.label === groupLabel)!;
  const keys = group.modules.flatMap((m) => [...m.lines, ...m.extras.map((e) => e.key)]);
  return keys.filter((k) => catalogSwitch(k).kind === 'toggle');
}

const onCount = (keys: string[], values: SwitchSet) =>
  keys.filter((k) => values[k] === true && !unmetRequirement(catalogSwitch(k), values)).length;

const groupToggle = (title: string) => screen.getByRole('button', { name: title });

describe('SwitchSetEditor, collapsible groups', () => {
  it('draws every group open, with its switches showing and no count beside the heading', () => {
    draw();
    for (const g of FIXTURE_LAYOUT.groups) {
      expect(groupToggle(g.label)).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.queryByText(/\d+ of \d+ on/)).toBeNull();
  });

  it('hides a collapsed group\'s rows and shows how many of its switches are on', async () => {
    const user = userEvent.setup();
    const values = presetSet('DISPATCHER');
    draw(values);
    const group = FIXTURE_LAYOUT.groups[0]!;
    const keys = toggleKeysOf(group.label);
    expect(keys.length).toBeGreaterThan(0);
    const region = screen.getByRole('region', { name: group.label });
    expect(within(region).getAllByRole('switch').length).toBe(keys.length);

    await user.click(groupToggle(group.label));
    await waitFor(() => expect(within(region).queryAllByRole('switch')).toHaveLength(0));
    expect(groupToggle(group.label)).toHaveAttribute('aria-expanded', 'false');
    expect(within(region).getByText(`${onCount(keys, values)} of ${keys.length} on`)).toBeInTheDocument();
    // The heading is still the group's name, so the page outline reads as before.
    expect(within(region).getByRole('heading')).toHaveTextContent(group.label);
  });

  it('counts a switch that waits on a switch that is off as off, as the row draws it', async () => {
    const user = userEvent.setup();
    // Every switch holding "on", so any shortfall in the count can only come from a requirement left unmet.
    const values: SwitchSet = { ...presetSet('DISPATCHER') };
    const group = FIXTURE_LAYOUT.groups.find((g) => toggleKeysOf(g.label).some((k) => catalogSwitch(k).requires.length > 0))!;
    const keys = toggleKeysOf(group.label);
    const dependent = keys.find((k) => catalogSwitch(k).requires.length > 0)!;
    values[dependent] = true;
    for (const r of catalogSwitch(dependent).requires) values[r] = false;
    draw(values);

    await user.click(groupToggle(group.label));
    await waitFor(() => expect(screen.getByText(/\d+ of \d+ on/)).toBeInTheDocument());
    expect(within(screen.getByRole('region', { name: group.label })).getByText(`${onCount(keys, values)} of ${keys.length} on`)).toBeInTheDocument();
  });

  it('opens a collapsed group again with its rows back at the values they held', async () => {
    const user = userEvent.setup();
    draw();
    const group = FIXTURE_LAYOUT.groups[0]!;
    const key = toggleKeysOf(group.label)[0]!;
    const before = screen.getByRole('switch', { name: catalogSwitch(key).label }).getAttribute('aria-checked');

    await user.click(groupToggle(group.label));
    await waitFor(() => expect(screen.queryByRole('switch', { name: catalogSwitch(key).label })).toBeNull());
    await user.click(groupToggle(group.label));
    expect((await screen.findByRole('switch', { name: catalogSwitch(key).label })).getAttribute('aria-checked')).toBe(before);
    expect(screen.queryByText(/\d+ of \d+ on/)).toBeNull();
  });

  it('collapses the Money block the same way, counting its switches', async () => {
    const user = userEvent.setup();
    const values = presetSet('SALES');
    draw(values);
    const keys = FIXTURE_LAYOUT.money.map((m) => m.key).filter((k) => catalogSwitch(k).kind === 'toggle');
    await user.click(groupToggle('Money'));
    const region = screen.getByRole('region', { name: 'Money' });
    await waitFor(() => expect(within(region).queryAllByRole('switch')).toHaveLength(0));
    expect(within(region).getByText(`${onCount(keys, values)} of ${keys.length} on`)).toBeInTheDocument();
  });

  it('collapses one group without touching the others', async () => {
    const user = userEvent.setup();
    draw();
    const [first, second] = FIXTURE_LAYOUT.groups;
    await user.click(groupToggle(first!.label));
    await waitFor(() => expect(within(screen.getByRole('region', { name: first!.label })).queryAllByRole('switch')).toHaveLength(0));
    expect(groupToggle(second!.label)).toHaveAttribute('aria-expanded', 'true');
    expect(within(screen.getByRole('region', { name: second!.label })).getAllByRole('switch').length).toBe(toggleKeysOf(second!.label).length);
  });
});

describe('SwitchSetEditor, rows on a phone', () => {
  it('stacks a switch row label over control below md, and puts them side by side from md', () => {
    draw();
    const key = toggleKeysOf(FIXTURE_LAYOUT.groups[0]!.label)[0]!;
    const control = screen.getByRole('switch', { name: catalogSwitch(key).label });
    const row = control.closest('[data-switch-line]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row).toHaveClass('flex-col', 'items-start', 'md:flex-row', 'md:items-center', 'md:justify-between');
    // Label first, control after it, so the stack reads label then control.
    const label = within(row).getByText(catalogSwitch(key).label);
    expect(label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stacks a choice row the same way and lets its options wrap rather than push past the edge', () => {
    draw();
    const choice = FIXTURE_CATALOG.switches.find((s) => s.kind === 'choice')!;
    const group = screen.getByRole('radiogroup', { name: choice.label });
    expect(group).toHaveClass('flex-wrap');
    expect(group.closest('[data-switch-line]')).toHaveClass('flex-col', 'md:flex-row');
  });

  it('gives a note under a row the full width of the stack, never a flex basis along the column', () => {
    draw({ ...presetSet('DISPATCHER'), view_customers: false });
    const gated = FIXTURE_CATALOG.switches.find((s) => s.kind === 'toggle' && s.requires.includes('view_customers'))!;
    const row = screen.getByRole('switch', { name: gated.label }).closest('[data-switch-line]')!;
    const note = within(row as HTMLElement).getByText(/^Requires /);
    expect(note).toHaveClass('w-full', 'md:basis-full');
    expect(note.className).not.toMatch(/(^|\s)basis-full/);
  });

  it('keeps every row inside the page: the lines grid is one column below md', () => {
    const { container } = draw();
    const grid = container.querySelector('ul.grid')!;
    expect(grid).toHaveClass('grid-cols-1');
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-[2-9]/);
  });
});
