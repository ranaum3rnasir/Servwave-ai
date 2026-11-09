/**
 * Roles & Permissions, PRD 2, M12 (S02.3) - Data Scope in each scoped row, choice switches as options, the kept
 * "Through own leads" value, and the line on the rows with no scope of their own.
 *
 * Through the editor's public interface (catalog and set in, edited set out). Row membership, labels and the line's
 * words are read from the catalog fixture, which has the shape of the server's catalog read.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import SwitchSetEditor from '@/components/permissions/SwitchSetEditor';
import type { SwitchSet } from '@/lib/api/shared/switchTypes';
import { FIXTURE_CATALOG, FIXTURE_LAYOUT, FIXTURE_DRAWN_SWITCHES, FIXTURE_SWITCHES, catalogSwitch, presetSet } from './support/permissionCatalogFixture';

function Harness({ initial, editable = true, onChange }: { initial: SwitchSet; editable?: boolean; onChange?: (next: SwitchSet) => void }) {
  const [values, setValues] = useState(initial);
  return (
    <TooltipProvider>
      <SwitchSetEditor
        catalog={FIXTURE_CATALOG}
        values={values}
        editable={editable}
        onChange={(next) => {
          setValues(next);
          onChange?.(next);
        }}
      />
    </TooltipProvider>
  );
}

const allRows = () => FIXTURE_LAYOUT.groups.flatMap((g) => g.modules);
const scopedRows = () => allRows().filter((row) => row.scope);
const row = (label: string) => screen.getByRole('group', { name: label });
const optionNames = (group: HTMLElement) => within(group).getAllByRole('radio').map((r) => r.textContent);

/** The choices of the fixture's scope switches, in words ("attached" is "Attached"). */
const SCOPE_WORDS = ['Attached', 'Team', 'All'];

describe('SwitchSetEditor, Data Scope in each scoped row', () => {
  it('holds a scope control in each of the scoped rows, next to the row, and nowhere else', () => {
    render(<Harness initial={presetSet('ADMIN')} />);
    expect(scopedRows().length).toBeGreaterThan(0);
    for (const scoped of scopedRows()) {
      const control = within(row(scoped.label)).getByRole('radiogroup', { name: catalogSwitch(scoped.scope!).label });
      expect(optionNames(control)).toEqual(SCOPE_WORDS);
    }
    // Every control that offers the scope choices is one of those rows' own: no second copy on the page.
    const withScopeChoices = screen.getAllByRole('radiogroup').filter((g) => optionNames(g).join() === SCOPE_WORDS.join());
    expect(withScopeChoices).toHaveLength(scopedRows().length);
    expect(within(screen.getByRole('region', { name: 'Money' })).queryByRole('radiogroup')).toBeNull();
    for (const module of allRows().filter((m) => !m.scope)) {
      const choices = within(row(module.label)).queryAllByRole('radiogroup').filter((g) => optionNames(g).join() === SCOPE_WORDS.join());
      expect(choices, module.label).toHaveLength(0);
    }
  });

  it('puts the scope choice beside the row\'s View, ahead of the row\'s other switches', () => {
    render(<Harness initial={presetSet('ADMIN')} />);
    for (const scoped of scopedRows()) {
      const inRow = row(scoped.label);
      const view = scoped.lines.find((k) => k.startsWith('view_'))!;
      const viewEl = within(inRow).getByRole('switch', { name: catalogSwitch(view).label });
      const scopeEl = within(inRow).getByRole('radiogroup', { name: catalogSwitch(scoped.scope!).label });
      expect(viewEl.compareDocumentPosition(scopeEl) & Node.DOCUMENT_POSITION_FOLLOWING, scoped.label).toBeTruthy();
      for (const extra of scoped.extras.filter((e) => e.parent === null && catalogSwitch(e.key).kind === 'toggle')) {
        const extraEl = within(inRow).getByRole('switch', { name: catalogSwitch(extra.key).label });
        expect(scopeEl.compareDocumentPosition(extraEl) & Node.DOCUMENT_POSITION_FOLLOWING, `${scoped.label}: ${extra.key}`).toBeTruthy();
      }
    }
  });

  it('hands back the chosen scope as the value the server stores', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const initial = presetSet('TECHNICIAN');
    render(<Harness initial={initial} onChange={onChange} />);
    await user.click(within(screen.getByRole('radiogroup', { name: 'Leads scope' })).getByRole('radio', { name: 'Team' }));
    expect(onChange).toHaveBeenCalledWith({ ...initial, leads_scope: 'team' });
  });
});

describe('SwitchSetEditor, choices as options', () => {
  it('draws every choice switch as a set of options with the chosen one checked, never a toggle', () => {
    render(<Harness initial={presetSet('DISPATCHER')} />);
    const choices = FIXTURE_DRAWN_SWITCHES.filter((s) => s.kind === 'choice');
    expect(choices.length).toBeGreaterThan(0);
    for (const s of choices) {
      expect(screen.queryByRole('switch', { name: s.label }), s.label).toBeNull();
      const group = screen.getByRole('radiogroup', { name: s.label });
      expect(within(group).getAllByRole('radio'), s.label).toHaveLength(s.choices!.length);
      const stored = presetSet('DISPATCHER')[s.key];
      const checked = within(group).queryAllByRole('radio', { checked: true });
      expect(checked, s.label).toHaveLength(1);
      expect(checked[0]!.textContent!.toLowerCase().replace(/ /g, '_'), s.label).toBe(stored);
    }
  });

  it('reads Communication scope as Attached / Team / All, and does not draw Inventory view: it is a setting on the person', () => {
    render(<Harness initial={presetSet('SALES')} />);
    expect(optionNames(screen.getByRole('radiogroup', { name: catalogSwitch('communication_scope').label }))).toEqual(['Attached', 'Team', 'All']);
    expect(screen.queryByRole('radiogroup', { name: catalogSwitch('inventory_view').label })).toBeNull();
  });
});

describe('SwitchSetEditor, the kept "Through own leads" value', () => {
  const keptKeys = FIXTURE_SWITCHES.filter((s) => s.keptValueHelp?.through_own_leads).map((s) => s.key);

  it('is held by Sales on Jobs in the fixture', () => {
    expect(keptKeys.sort()).toEqual(['jobs_scope']);
    for (const key of keptKeys) expect(presetSet('SALES')[key]).toBe('through_own_leads');
  });

  it('shows the value read-only with its meaning, beside the three real choices, none of them checked', () => {
    render(<Harness initial={presetSet('SALES')} />);
    for (const key of keptKeys) {
      const s = catalogSwitch(key);
      const kept = s.keptValueHelp!.through_own_leads!;
      const group = screen.getByRole('radiogroup', { name: s.label });
      expect(optionNames(group), key).toEqual(SCOPE_WORDS);
      expect(within(group).queryAllByRole('radio', { checked: true }), key).toHaveLength(0);
      const line = screen.getByText(kept.meaning).parentElement!;
      expect(line, key).toHaveTextContent(kept.label);
      // Read-only: the value is words on the page, not a control anyone can press.
      expect(within(line).queryAllByRole('radio'), key).toHaveLength(0);
      expect(within(line).queryAllByRole('button'), key).toHaveLength(0);
      // And it sits in the scope's own row.
      expect(line.closest('[role=group]'), key).toContainElement(group);
    }
  });

  it('says Owner and never assigned or assignee for a lead\'s Owner', () => {
    render(<Harness initial={presetSet('SALES')} />);
    for (const key of keptKeys) {
      const meaning = catalogSwitch(key).keptValueHelp!.through_own_leads!.meaning;
      expect(meaning).toMatch(/Owner/);
      expect(screen.getByText(meaning).textContent).not.toMatch(/assign/i);
    }
  });

  it('is replaced by one click on Attached, and is not on offer again afterwards', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const initial = presetSet('SALES');
    render(<Harness initial={initial} onChange={onChange} />);
    const s = catalogSwitch('jobs_scope');
    const kept = s.keptValueHelp!.through_own_leads!;

    await user.click(within(screen.getByRole('radiogroup', { name: s.label })).getByRole('radio', { name: 'Attached' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...initial, jobs_scope: 'attached' });

    expect(screen.queryByText(kept.meaning)).toBeNull();
    const group = screen.getByRole('radiogroup', { name: s.label });
    expect(within(group).getByRole('radio', { name: 'Attached' })).toBeChecked();
    expect(within(group).queryByRole('radio', { name: kept.label })).toBeNull();
    expect(optionNames(group)).toEqual(SCOPE_WORDS);
    // Jobs scope is the only scope that held the kept value: once it moved, none shows it.
    expect(screen.queryAllByText(kept.label, { exact: false })).toHaveLength(keptKeys.length - 1);
  });

  it('shows the kept value\'s name as the value when the set is read-only, with no option to press', () => {
    render(<Harness initial={presetSet('SALES')} editable={false} />);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.getAllByText('Through own leads', { exact: false }).length).toBeGreaterThanOrEqual(keptKeys.length);
  });
});

describe('SwitchSetEditor, rows with no scope of their own', () => {
  it('carries the catalog\'s line on Customers, Estimates, Invoices, Purchase Orders and Logistic Orders, and on no other row', () => {
    render(<Harness initial={presetSet('ADMIN')} />);
    const withLine = allRows().filter((m) => m.scopeNote);
    expect(withLine.map((m) => m.module).sort()).toEqual(['Customers', 'Estimates', 'Invoices', 'Logistic Orders', 'Purchase Orders']);
    for (const m of withLine) expect(within(row(m.label)).getByText(m.scopeNote!), m.label).toBeInTheDocument();
    for (const m of allRows().filter((r) => !r.scopeNote)) {
      expect(within(row(m.label)).queryByText(/follows the leads and jobs/i), m.label).toBeNull();
    }
    expect(screen.getAllByText(/follows the leads and jobs this person can open\./i)).toHaveLength(withLine.length);
  });

  it('no longer says any scope applies at All', () => {
    const { container } = render(<Harness initial={presetSet('SALES')} />);
    expect(container.textContent).not.toMatch(/appl(y|ies) at all/i);
  });

  it('reads the same line when the set is read-only', () => {
    render(<Harness initial={presetSet('SALES')} editable={false} />);
    expect(screen.getAllByText(/follows the leads and jobs this person can open\./i).length).toBeGreaterThan(0);
  });
});
