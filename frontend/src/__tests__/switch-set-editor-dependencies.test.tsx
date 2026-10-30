/**
 * Roles & Permissions, PRD 2, M12 (S02.2) - dependencies on screen, through the shared switch-set editor's public
 * interface: the catalog and a set in, the edited set out.
 *
 * Which switch needs which is read from the catalog fixture's `requires` and `requiresAny`, and every label from its
 * switches, never written into a test as a second list.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import SwitchSetEditor from '@/components/permissions/SwitchSetEditor';
import type { SwitchSet } from '@/lib/api/permissionSwitches';
import { FIXTURE_CATALOG, FIXTURE_DRAWN_SWITCHES, FIXTURE_LAYOUT, FIXTURE_SWITCHES, catalogSwitch } from './support/permissionCatalogFixture';

function Harness({ initial, onChange }: { initial: SwitchSet; onChange?: (next: SwitchSet) => void }) {
  const [values, setValues] = useState(initial);
  return (
    <TooltipProvider>
      <SwitchSetEditor
        catalog={FIXTURE_CATALOG}
        values={values}
        editable
        onChange={(next) => {
          setValues(next);
          onChange?.(next);
        }}
      />
    </TooltipProvider>
  );
}

/** Everything on: every requirement is met, so nothing starts greyed. */
const allOn = (): SwitchSet =>
  Object.fromEntries(
    FIXTURE_SWITCHES.map((s) => [s.key, s.kind === 'toggle' ? true : s.kind === 'choice' ? s.choices![0]! : 'all_accepted']),
  );

const toggleOf = (key: string) => screen.getByRole('switch', { name: catalogSwitch(key).label });
const dependentsOf = (key: string) => FIXTURE_SWITCHES.filter((s) => s.requires.includes(key));
/** The "Requires ..." note a switch is described by: the one drawn on its own line, not a nested switch's. */
const noteOf = (key: string) => {
  const id = toggleOf(key).getAttribute('aria-describedby');
  const note = id ? document.getElementById(id) : null;
  return note ? [note.textContent] : [];
};
const rowView = (module: string) => FIXTURE_LAYOUT.groups.flatMap((g) => g.modules).find((m) => m.module === module)!.lines[0]!;

describe('SwitchSetEditor, the row rule', () => {
  it('clears and greys the rest of a row\'s first line, and every switch needing the View, when View goes off', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={allOn()} onChange={onChange} />);
    await user.click(toggleOf('view_customers'));

    const dependents = dependentsOf('view_customers');
    expect(dependents.length).toBeGreaterThan(1);
    const sent = onChange.mock.calls.at(-1)![0] as SwitchSet;
    expect(sent.view_customers).toBe(false);
    for (const d of dependents) {
      expect(sent[d.key], d.label).toBe(false);
      expect(toggleOf(d.key), d.label).toBeDisabled();
      expect(noteOf(d.key), d.label).toEqual(['Requires View']);
    }
  });

  it('clears a switch nested under a cleared one, and greys it with the label of the switch it now needs', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={allOn()} onChange={onChange} />);
    await user.click(toggleOf('view_customers'));
    // Change customer created date needs Edit customers, which View took with it.
    const sent = onChange.mock.calls.at(-1)![0] as SwitchSet;
    expect(sent.change_customer_created_date).toBe(false);
    expect(toggleOf('change_customer_created_date')).toBeDisabled();
    expect(noteOf('change_customer_created_date')).toEqual([`Requires ${catalogSwitch('edit_customers').label}`]);
  });

  it('leaves a row alone when another row\'s View goes off', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={allOn()} onChange={onChange} />);
    await user.click(toggleOf('view_customers'));
    for (const d of dependentsOf('view_leads')) {
      expect(toggleOf(d.key), d.label).toBeEnabled();
      expect(noteOf(d.key), d.label).toEqual([]);
    }
  });
});

describe('SwitchSetEditor, any other requirement', () => {
  it('greys a switch with "Requires <label>" when the switch it needs is off, label read from the catalog', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={allOn()} onChange={onChange} />);
    await user.click(toggleOf('access_communication'));

    const dependents = dependentsOf('access_communication');
    expect(dependents.length).toBeGreaterThan(0);
    const sent = onChange.mock.calls.at(-1)![0] as SwitchSet;
    for (const d of dependents) {
      expect(sent[d.key], d.label).toBe(false);
      expect(toggleOf(d.key), d.label).toBeDisabled();
      expect(noteOf(d.key), d.label).toEqual([`Requires ${catalogSwitch('access_communication').label}`]);
    }
  });

  it('names both switches when a switch needs at least one of two', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={allOn()} onChange={onChange} />);
    const key = 'edit_job_and_lead_contact_details';
    const either = catalogSwitch(key).requiresAny!;
    await user.click(toggleOf(either[0]!));
    expect(toggleOf(key)).toBeEnabled();
    await user.click(toggleOf(either[1]!));
    expect((onChange.mock.calls.at(-1)![0] as SwitchSet)[key]).toBe(false);
    expect(toggleOf(key)).toBeDisabled();
    expect(noteOf(key)).toEqual([`Requires ${either.map((k) => catalogSwitch(k).label).join(' or ')}`]);
  });

  it('draws no note and no grey on a set whose requirements are all met', () => {
    render(<Harness initial={allOn()} />);
    expect(screen.queryAllByText(/^Requires /)).toHaveLength(0);
    for (const s of FIXTURE_DRAWN_SWITCHES.filter((x) => x.kind === 'toggle')) expect(toggleOf(s.key), s.label).toBeEnabled();
  });
});

describe('SwitchSetEditor, turning a requirement back on', () => {
  it('lifts the grey but leaves every dependent off until it is turned on', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={allOn()} onChange={onChange} />);
    await user.click(toggleOf('view_customers'));
    await user.click(toggleOf('view_customers'));

    const sent = onChange.mock.calls.at(-1)![0] as SwitchSet;
    expect(sent.view_customers).toBe(true);
    for (const d of dependentsOf('view_customers')) {
      expect(sent[d.key], d.label).toBe(false);
      expect(toggleOf(d.key), d.label).toBeEnabled();
      expect(toggleOf(d.key).getAttribute('aria-checked'), d.label).toBe('false');
      expect(noteOf(d.key), d.label).toEqual([]);
    }
    // Turning one back on is its own choice: only that switch changes.
    const edit = dependentsOf('view_customers')[0]!;
    await user.click(toggleOf(edit.key));
    expect(onChange.mock.calls.at(-1)![0]).toEqual({ ...sent, [edit.key]: true });
  });
});

describe('SwitchSetEditor, the Communication row', () => {
  it('has View communication clear Contact customers, Attach conversations, and Edit and Delete communication records', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={allOn()} onChange={onChange} />);
    expect(rowView('Communication')).toBe('view_communication');
    await user.click(toggleOf('view_communication'));
    const sent = onChange.mock.calls.at(-1)![0] as SwitchSet;
    const cleared = ['contact_customers', 'attach_conversations', 'edit_communication_records', 'delete_communication_records'];
    for (const key of cleared) {
      expect(sent[key], key).toBe(false);
      expect(toggleOf(key), key).toBeDisabled();
      expect(noteOf(key), key).toEqual(['Requires View']);
    }
  });

  it('keeps Show Phone and Export call log governed by Access Communication, not by View communication', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={allOn()} onChange={onChange} />);
    await user.click(toggleOf('view_communication'));
    for (const key of ['show_phone', 'export_call_log']) {
      expect((onChange.mock.calls.at(-1)![0] as SwitchSet)[key], key).toBe(true);
      expect(toggleOf(key), key).toBeEnabled();
    }
    await user.click(toggleOf('access_communication'));
    for (const key of ['show_phone', 'export_call_log']) {
      expect((onChange.mock.calls.at(-1)![0] as SwitchSet)[key], key).toBe(false);
      expect(toggleOf(key), key).toBeDisabled();
    }
  });
});

describe('SwitchSetEditor, switches that need nothing', () => {
  it('does not grey Pick up staged items or Record pickup for someone else when Edit stock is off', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={allOn()} onChange={onChange} />);
    await user.click(toggleOf('edit_stock'));
    expect((onChange.mock.calls.at(-1)![0] as SwitchSet).edit_stock).toBe(false);
    for (const key of ['pick_up_staged_items', 'record_pickup_for_someone_else']) {
      expect(catalogSwitch(key).requires).toEqual([]);
      expect(toggleOf(key), key).toBeEnabled();
      expect(toggleOf(key).getAttribute('aria-checked'), key).toBe('true');
      expect(noteOf(key), key).toEqual([]);
    }
  });

  it('keeps the eligibility settings off Create leads and Create jobs: no warning, no grey, not drawn, the set sent unchanged', async () => {
    const eligibility = ['can_own_leads', 'can_be_dispatcher', 'can_be_on_crew'];
    const onChange = vi.fn();
    const user = userEvent.setup();
    const initial: SwitchSet = { ...allOn(), ...Object.fromEntries(eligibility.map((k) => [k, false])) };
    render(<Harness initial={initial} onChange={onChange} />);

    expect(screen.queryAllByText(/^Requires /)).toHaveLength(0);
    for (const key of ['create_leads', 'create_jobs']) expect(toggleOf(key), key).toBeEnabled();
    for (const key of eligibility) {
      expect(catalogSwitch(key).requires).toEqual([]);
      // A per-person setting (P1): edited on the person's profile, never drawn by the switch editor.
      expect(screen.queryByRole('switch', { name: catalogSwitch(key).label }), key).toBeNull();
    }
    // Flipping an unrelated switch hands back the whole set with Create leads and Create jobs still on.
    await user.click(toggleOf('show_phone'));
    expect(onChange).toHaveBeenLastCalledWith({ ...initial, show_phone: false });
  });
});
