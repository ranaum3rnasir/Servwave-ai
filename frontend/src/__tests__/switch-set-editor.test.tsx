/**
 * Roles & Permissions, PRD 2, M12 (S02.1) - the shared switch-set editor, through its public interface: the catalog and
 * a set in, the edited set out.
 *
 * Every expectation (labels, help text, order, groups, presets) is read from the catalog fixture, never written into
 * the test, and the fixture is the server's catalog-read shape.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import SwitchSetEditor from '@/components/permissions/SwitchSetEditor';
import type { SwitchCatalog, SwitchSet } from '@/lib/api/permissionSwitches';
import { FIXTURE_CATALOG, FIXTURE_LAYOUT, FIXTURE_SWITCHES, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

function Harness({
  catalog = FIXTURE_CATALOG,
  initial = presetSet('DISPATCHER'),
  editable = true,
  onChange,
}: {
  catalog?: SwitchCatalog;
  initial?: SwitchSet;
  editable?: boolean;
  onChange?: (next: SwitchSet) => void;
}) {
  const [values, setValues] = useState(initial);
  return (
    <TooltipProvider>
      <SwitchSetEditor
        catalog={catalog}
        values={values}
        editable={editable}
        acceptedMethods={{ data: { every_method: false, methods: catalogSwitch('allowed_payment_methods').listOptions! }, isError: false }}
        onChange={(next) => {
          setValues(next);
          onChange?.(next);
        }}
      />
    </TooltipProvider>
  );
}

const controlFor = (key: string) => {
  const s = catalogSwitch(key);
  if (s.kind === 'toggle') return screen.getByRole('switch', { name: s.label });
  if (s.kind === 'choice') return screen.getByRole('radiogroup', { name: s.label });
  return screen.getByRole('group', { name: s.label });
};

describe('SwitchSetEditor, what it draws', () => {
  it('draws a row for every switch of the catalog, each with a help icon', () => {
    render(<Harness />);
    expect(FIXTURE_SWITCHES.length).toBeGreaterThan(0);
    for (const s of FIXTURE_SWITCHES) {
      expect(controlFor(s.key), s.label).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `About ${s.label}` }), s.label).toBeInTheDocument();
    }
  });

  it('draws the groups in the catalog order, headings first, and the Data Scope block before them', () => {
    render(<Harness />);
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(['Data Scope', ...FIXTURE_LAYOUT.groups.map((g) => g.label)]);
  });

  it('holds only the two money lines in the Data Scope block, See financial data last', () => {
    render(<Harness />);
    const block = screen.getByRole('region', { name: 'Data Scope' });
    const labels = within(block).getAllByRole('switch').map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual(FIXTURE_LAYOUT.dataScope.map((k) => catalogSwitch(k).label));
    expect(within(block).queryByRole('radiogroup')).toBeNull();
  });

  it('draws a group heading over its modules with no switch of its own', () => {
    render(<Harness />);
    const inventory = screen.getByRole('region', { name: 'Inventory' });
    const rows = FIXTURE_LAYOUT.groups.find((g) => g.label === 'Inventory')!.modules;
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(within(inventory).getByRole('group', { name: row.label })).toBeInTheDocument();
    // The heading is not a switch: every control inside belongs to a module row's switches.
    const drawn = within(inventory).getAllByRole('switch').length;
    const expected = rows.flatMap((r) => [...r.lines, ...r.extras.map((e) => e.key)]).filter((k) => catalogSwitch(k).kind === 'toggle').length;
    expect(drawn).toBe(expected);
  });

  it('draws a row\'s first line before its extras, and a scope choice on the row it narrows', () => {
    render(<Harness />);
    const row = screen.getByRole('group', { name: 'Leads' });
    const leadsRow = FIXTURE_LAYOUT.groups.flatMap((g) => g.modules).find((m) => m.module === 'Leads')!;
    const order = within(row).getAllByRole('switch', { hidden: true }).map((el) => el.getAttribute('aria-label'));
    expect(order.slice(0, leadsRow.lines.length)).toEqual(leadsRow.lines.map((k) => catalogSwitch(k).label));
    expect(within(row).getByRole('radiogroup', { name: catalogSwitch(leadsRow.scope!).label })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Customers' }).querySelector('[role=radiogroup]')).toBeNull();
  });

  it('draws a module with no View (Settings, Pages) as its extras alone, with the payout-account switch among them (View payments now sits under Invoices)', () => {
    render(<Harness />);
    const settings = screen.getByRole('group', { name: 'Settings' });
    expect(within(settings).getByRole('switch', { name: catalogSwitch('manage_payout_account').label })).toBeInTheDocument();
    const invoices = screen.getByRole('group', { name: 'Invoices' });
    expect(within(invoices).getByRole('switch', { name: catalogSwitch('view_payments').label })).toBeInTheDocument();
    expect(within(settings).queryByRole('switch', { name: catalogSwitch('view_payments').label })).toBeNull();
    expect(screen.queryByRole('switch', { name: /dashboard/i })).toBeNull();
  });

  it('nests a switch under the one it narrows, whether that is a line of the row or another extra', () => {
    render(<Harness />);
    const nestedUnder = (child: string, parent: string) => {
      const parentItem = screen.getByRole('switch', { name: catalogSwitch(parent).label }).closest('li')!;
      expect(within(parentItem).getByRole('switch', { name: catalogSwitch(child).label })).toBeInTheDocument();
    };
    for (const row of FIXTURE_LAYOUT.groups.flatMap((g) => g.modules)) {
      for (const extra of row.extras) if (extra.parent) nestedUnder(extra.key, extra.parent);
    }
    // And one that stands on the row is not inside any other switch's item.
    const reopen = screen.getByRole('switch', { name: catalogSwitch('reopen_leads').label }).closest('li')!;
    expect(within(reopen).getAllByRole('switch')).toHaveLength(1);
  });

  it('shows the value of every kind of switch from the set it is given', () => {
    const values = { ...presetSet('SALES') };
    render(<Harness initial={values} />);
    for (const s of FIXTURE_SWITCHES.filter((x) => x.kind === 'toggle')) {
      const el = screen.getByRole('switch', { name: s.label });
      expect(el.getAttribute('aria-checked'), s.label).toBe(String(values[s.key]));
    }
    // A choice: the chosen option is the pressed one.
    const scope = screen.getByRole('radiogroup', { name: 'Leads scope' });
    expect(within(scope).getByRole('radio', { name: 'Attached' })).toBeChecked();
    expect(within(scope).getByRole('radio', { name: 'All' })).not.toBeChecked();
  });

  it('reads a choice\'s options as words: Linked to me and All on Communication scope', () => {
    render(<Harness />);
    const scope = screen.getByRole('radiogroup', { name: catalogSwitch('communication_scope').label });
    expect(within(scope).getAllByRole('radio').map((r) => r.getAttribute('aria-label') ?? r.textContent)).toEqual(['Linked to me', 'All']);
  });

  it('shows a kept scope value by its name and meaning instead of leaving the choice blank', () => {
    render(<Harness initial={presetSet('SALES')} />);
    const kept = catalogSwitch('jobs_scope').keptValueHelp!.through_own_leads!;
    const scope = screen.getByRole('radiogroup', { name: 'Jobs scope' });
    expect(within(scope).queryAllByRole('radio', { checked: true })).toHaveLength(0);
    const row = screen.getByRole('group', { name: 'Jobs' });
    expect(within(row).getByText(kept.label, { exact: false })).toBeInTheDocument();
    expect(within(row).getByText(kept.meaning, { exact: false })).toBeInTheDocument();
  });

  it('draws a list switch as All accepted methods plus a checklist of its options', () => {
    render(<Harness />);
    const list = screen.getByRole('group', { name: catalogSwitch('allowed_payment_methods').label });
    expect(within(list).getByRole('checkbox', { name: 'All accepted methods' })).toBeChecked();
    expect(within(list).queryByRole('checkbox', { name: 'Check' })).toBeNull();
  });
});

describe('SwitchSetEditor, help icons', () => {
  it('opens the catalog\'s help text, verbatim, on a tap with a touch pointer', () => {
    render(<Harness />);
    const label = catalogSwitch('reopen_leads').label;
    const icon = screen.getByRole('button', { name: `About ${label}` });
    fireEvent.pointerDown(icon, { pointerType: 'touch' });
    fireEvent.click(icon);
    expect(screen.getByText(catalogSwitch('reopen_leads').helpText)).toBeInTheDocument();
  });

  it('opens it on hover with a mouse and closes it again when the mouse leaves', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const label = catalogSwitch('view_customers').label;
    const icon = screen.getByRole('button', { name: `About ${label}` });
    await user.hover(icon);
    expect(await screen.findByText(catalogSwitch('view_customers').helpText)).toBeInTheDocument();
    await user.unhover(icon);
    expect(screen.queryByText(catalogSwitch('view_customers').helpText)).toBeNull();
  });
});

describe('SwitchSetEditor, editing', () => {
  it('hands back the whole set with the one toggle flipped', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const initial = presetSet('DISPATCHER');
    render(<Harness initial={initial} onChange={onChange} />);
    const key = 'reopen_leads';
    await user.click(screen.getByRole('switch', { name: catalogSwitch(key).label }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...initial, [key]: !initial[key] });
  });

  it('hands back the chosen option of a choice, as the value the server stores', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const initial = presetSet('DISPATCHER');
    render(<Harness initial={initial} onChange={onChange} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Communication scope' })).getByRole('radio', { name: 'Linked to me' }));
    expect(onChange).toHaveBeenCalledWith({ ...initial, communication_scope: 'linked_to_me' });
  });

  it('hands back a ticked subset of a list switch, and the marker again when All accepted is ticked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const initial = presetSet('DISPATCHER');
    render(<Harness initial={initial} onChange={onChange} />);
    const list = () => screen.getByRole('group', { name: 'Allowed payment methods' });
    await user.click(within(list()).getByRole('checkbox', { name: 'All accepted methods' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...initial, allowed_payment_methods: [] });
    await user.click(within(list()).getByRole('checkbox', { name: 'Check' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...initial, allowed_payment_methods: ['CHECK'] });
    await user.click(within(list()).getByRole('checkbox', { name: 'All accepted methods' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...initial, allowed_payment_methods: 'all_accepted' });
  });

  it('draws no editable control when it is read-only, but still shows each value and the help icons', () => {
    render(<Harness editable={false} />);
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // The only buttons are the help icons and the group headings that fold a group away.
    expect(screen.getAllByRole('button').every((b) => /^About /.test(b.getAttribute('aria-label') ?? '') || b.hasAttribute('aria-expanded'))).toBe(true);
    expect(screen.getAllByText('On').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Off').length).toBeGreaterThan(0);
  });
});
