import { useId, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { Collapse } from '@/components/ui/collapse';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Switch } from '@/ui-kit/components/ui/switch';
import { cn } from '@/ui-kit/lib/utils';
import {
  ALL_ACCEPTED,
  type AcceptedPaymentMethods,
  clearDependents,
  sameValue,
  unmetRequirement,
  type CatalogSwitch,
  type LayoutExtra,
  type LayoutModule,
  type SwitchCatalog,
  type SwitchSet,
  type SwitchValue,
  type UnmetRequirement,
} from '@/lib/api/permissionSwitches';

import { HelpIcon } from './HelpIcon';
import { choiceLabel, optionLabel, valueText } from './switchValueText';

/**
 * M12 - the shared switch-set editor (Roles & Permissions, PRD 2).
 *
 * Takes the catalog the server reads out, a set of switch values, whether it may be edited and a change callback,
 * and hands back the edited set. It draws only what the catalog says: the Money row, then each group's module
 * rows, with a switch nested under the one it narrows and the catalog's help text behind every switch. It keeps no
 * list of switches, labels or help text of its own, so the Roles page and a person's Permissions page cannot drift.
 *
 * It also applies the catalog's dependencies: a switch whose requirement is off is cleared and greyed with a
 * "Requires ..." note, and turning the requirement back on leaves it off.
 */

interface EditorProps {
  catalog: SwitchCatalog;
  values: SwitchSet;
  editable: boolean;
  onChange: (next: SwitchSet) => void;
  /** The role the set is compared with: a switch that differs from it is highlighted and, when editable, offers a reset. */
  basedOn?: BasedOnComparison;
  /** The company's accepted payment methods, as the screen read them: what a list switch's checklist offers. */
  acceptedMethods?: { data?: AcceptedPaymentMethods; isError: boolean };
}

/** The role a person's set is compared with, and how to put one switch back to it. */
export interface BasedOnComparison {
  label: string;
  /** The role's current value for every switch. */
  values: SwitchSet;
  onReset: (key: string) => void;
  /** True while a reset is being sent, so it cannot be sent twice. */
  busy?: boolean;
}

interface DrawContext {
  byKey: Map<string, CatalogSwitch>;
  values: SwitchSet;
  editable: boolean;
  set: (key: string, value: SwitchValue) => void;
  basedOn?: BasedOnComparison;
  acceptedMethods?: EditorProps['acceptedMethods'];
}

/** The row's View, which a "Requires" note names plainly as "View" instead of "View customers". */
type RowView = string | undefined;

// One class string for the lines of a row, written once so a repeat of it never trips the form-grid guard.
const LINES_GRID = cn('grid grid-cols-1 gap-x-8 gap-y-1 md:grid-cols-2 xl:grid-cols-3');

export default function SwitchSetEditor({ catalog, values, editable, onChange, basedOn, acceptedMethods }: EditorProps) {
  const byKey = useMemo(() => new Map(catalog.switches.map((s) => [s.key, s])), [catalog]);
  const ctx: DrawContext = { byKey, values, editable, basedOn, acceptedMethods, set: (key, value) => onChange(clearDependents(catalog, { ...values, [key]: value })) };
  const { money, groups } = catalog.layout;
  const moneyKeys = money.map((m) => m.key);
  const moneyChildren = (key: string) => money.filter((m) => m.parent === key);

  return (
    <div className="space-y-4">
      <Block title="Money" onCount={switchesOn(moneyKeys, ctx)}>
        <ul className="space-y-0.5">
          {money
            .filter((m) => m.parent === null)
            .map((m) => (
              <li key={m.key}>
                <SwitchLine sw={ctx.byKey.get(m.key)} ctx={ctx} />
                <Nested items={moneyChildren(m.key)} childrenOf={moneyChildren} ctx={ctx} rowView={undefined} />
              </li>
            ))}
        </ul>
      </Block>
      {groups.map((group) => (
        <Block key={group.label} title={group.label} onCount={switchesOn(groupKeys(group.modules), ctx)}>
          {group.modules.map((row) => (
            <ModuleRow key={row.module} row={row} showLabel={row.label !== group.label} ctx={ctx} />
          ))}
        </Block>
      ))}
    </div>
  );
}

/** Every switch a group's rows hold: each row's lines and extras, wherever they nest. */
const groupKeys = (modules: LayoutModule[]) => modules.flatMap((row) => [...row.lines, ...row.extras.map((e) => e.key)]);

/**
 * How many of a block's on/off switches are on, out of how many it has. A switch waiting on another that is off is
 * counted off, because that is how its row draws it. Choices and lists are not on or off, so they are not counted.
 */
function switchesOn(keys: string[], ctx: DrawContext): { on: number; of: number } {
  const toggles = keys.map((key) => ctx.byKey.get(key)).filter((sw): sw is CatalogSwitch => sw?.kind === 'toggle');
  return { of: toggles.length, on: toggles.filter((sw) => ctx.values[sw.key] === true && !unmetRequirement(sw, ctx.values)).length };
}

/**
 * A titled card: a group of the catalog, or the Money block. Its heading carries no switch. The heading folds the
 * card away; folded, the card says how many of its switches are on. A card draws open, and stays as the person left it
 * while another role is picked.
 */
function Block({ title, onCount, children }: { title: string; onCount: { on: number; of: number }; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return (
    <section aria-label={title}>
      <Card>
        <div className="flex flex-col gap-3 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-3">
            {/* role/aria-level rather than an <h3>: the raw-tag ratchet sits at its floor for h1-h6. */}
            <p role="heading" aria-level={3} className="min-w-0 flex-1 text-sm font-semibold">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={open}
                aria-controls={open ? bodyId : undefined}
                onClick={() => setOpen((o) => !o)}
                className="-ml-2 w-full justify-start gap-1.5 px-2 font-semibold"
              >
                <ChevronDown aria-hidden="true" className={cn('text-muted-foreground h-4 w-4 shrink-0 transition-transform', !open && '-rotate-90')} />
                {title}
              </Button>
            </p>
            {!open && (
              <span className="text-muted-foreground shrink-0 text-xs">
                {onCount.on} of {onCount.of} on
              </span>
            )}
          </div>
          <Collapse open={open}>
            <div id={bodyId} className="flex flex-col gap-3">
              {children}
            </div>
          </Collapse>
        </div>
      </Card>
    </section>
  );
}

function ModuleRow({ row, showLabel, ctx }: { row: LayoutModule; showLabel: boolean; ctx: DrawContext }) {
  const rowKeys = new Set([...row.lines, ...row.extras.map((e) => e.key)]);
  // A switch whose parent is not in this row stands on the row.
  const childrenOf = (key: string) => row.extras.filter((e) => e.parent === key && rowKeys.has(key));
  const topExtras = row.extras.filter((e) => e.parent === null || !rowKeys.has(e.parent));
  const scope = row.scope ? ctx.byKey.get(row.scope) : undefined;
  const view = row.lines.find((key) => key.startsWith('view_'));

  return (
    <div role="group" aria-label={row.label} className="space-y-1 border-t pt-3 first:border-t-0 first:pt-0">
      {showLabel && <p className="text-muted-foreground text-xs font-semibold">{row.label}</p>}
      {row.lines.length > 0 && (
        <ul className={LINES_GRID}>
          {row.lines.map((key) => (
            <li key={key} className="min-w-0">
              <SwitchLine sw={ctx.byKey.get(key)} ctx={ctx} rowView={view} />
              <Nested items={childrenOf(key)} childrenOf={childrenOf} ctx={ctx} rowView={view} />
            </li>
          ))}
        </ul>
      )}
      {row.scopeNote && <p className="text-muted-foreground text-xs">{row.scopeNote}</p>}
      {(scope || topExtras.length > 0) && (
        <ul className="space-y-0.5">
          {scope && (
            <li>
              <SwitchLine sw={scope} ctx={ctx} rowView={view} />
            </li>
          )}
          {topExtras.map((extra) => (
            <li key={extra.key}>
              <SwitchLine sw={ctx.byKey.get(extra.key)} ctx={ctx} rowView={view} />
              <Nested items={childrenOf(extra.key)} childrenOf={childrenOf} ctx={ctx} rowView={view} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The switches that narrow another, drawn under it and set in. */
function Nested({
  items,
  childrenOf,
  ctx,
  rowView,
}: {
  items: LayoutExtra[];
  childrenOf: (key: string) => LayoutExtra[];
  ctx: DrawContext;
  rowView: RowView;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="border-border ml-3 space-y-0.5 border-l pl-3">
      {items.map((item) => (
        <li key={item.key}>
          <SwitchLine sw={ctx.byKey.get(item.key)} ctx={ctx} rowView={rowView} />
          <Nested items={childrenOf(item.key)} childrenOf={childrenOf} ctx={ctx} rowView={rowView} />
        </li>
      ))}
    </ul>
  );
}

/** One switch: its label with the help icon, and the control (or, read-only, the value) beside it. */
function SwitchLine({ sw, ctx, rowView }: { sw: CatalogSwitch | undefined; ctx: DrawContext; rowView?: RowView }) {
  const id = useId();
  const noteId = useId();
  if (!sw) return null;
  const unmet = unmetRequirement(sw, ctx.values);
  const note = unmet ? requiresNote(unmet, ctx.byKey, rowView) : null;
  // A switch waiting on another is off, whatever the set still holds for it, until its requirement is on again.
  const value = unmet && sw.kind === 'toggle' ? false : ctx.values[sw.key];
  const wide = sw.kind === 'list' && ctx.editable;
  const differs = !!ctx.basedOn && !sameValue(ctx.values[sw.key], ctx.basedOn.values[sw.key]);

  return (
    // Label over control below md; side by side from md, wrapping when the control is wide.
    <div
      data-switch-line
      data-differs={differs ? 'true' : undefined}
      className={cn(
        'flex flex-col items-start gap-1.5 py-1 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-x-3',
        differs && 'bg-primary/5 border-primary -mx-2 rounded-sm border-l-2 px-2',
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <label htmlFor={id} className="min-w-0 text-sm">
          {sw.label}
        </label>
        <HelpIcon label={sw.label} text={sw.helpText} />
      </div>
      {!ctx.editable ? (
        <span id={id} className="text-muted-foreground text-sm">
          {valueText(sw, value)}
        </span>
      ) : sw.kind === 'toggle' ? (
        <Switch
          id={id}
          aria-label={sw.label}
          aria-describedby={note ? noteId : undefined}
          checked={value === true}
          disabled={!!unmet}
          onCheckedChange={(on) => ctx.set(sw.key, on)}
        />
      ) : sw.kind === 'choice' ? (
        <ChoiceControl sw={sw} value={value} onPick={(choice) => ctx.set(sw.key, choice)} />
      ) : (
        <div className={cn('w-full md:w-auto', wide && 'md:basis-full')}>
          <ListControl sw={sw} value={value} accepted={ctx.acceptedMethods} onChange={(next) => ctx.set(sw.key, next)} />
        </div>
      )}
      {note && (
        <p id={noteId} className="text-muted-foreground w-full text-xs md:basis-full">
          {note}
        </p>
      )}
      {differs && ctx.editable && ctx.basedOn && (
        <div className="w-full md:basis-full">
          <Button
            type="button"
            variant="link"
            size="sm"
            disabled={ctx.basedOn.busy}
            onClick={() => ctx.basedOn?.onReset(sw.key)}
            className="h-auto p-0 text-xs"
          >
            Reset to {ctx.basedOn.label}
            <span className="sr-only"> {sw.label}</span>
          </Button>
        </div>
      )}
      {sw.kind === 'choice' && typeof value === 'string' && !sw.choices?.includes(value) && sw.keptValueHelp?.[value] && (
        <p className="text-muted-foreground w-full text-xs md:basis-full">
          <span className="font-medium">{sw.keptValueHelp[value].label}</span> <span>{sw.keptValueHelp[value].meaning}</span>
        </p>
      )}
    </div>
  );
}

/** "Requires View" for the row's own View, otherwise "Requires <label>", the labels read from the catalog. */
function requiresNote(unmet: UnmetRequirement, byKey: Map<string, CatalogSwitch>, rowView: RowView): string {
  const label = (key: string) => byKey.get(key)?.label ?? key;
  // Of two switches, one of which will do, the row's View is named in full: "View" alone would not say which.
  const parts = [
    unmet.all.map((key) => (key === rowView ? 'View' : label(key))).join(' and '),
    unmet.any.map(label).join(' or '),
  ].filter(Boolean);
  return `Requires ${parts.join(' and ')}`;
}

function ChoiceControl({
  sw,
  value,
  onPick,
}: {
  sw: CatalogSwitch;
  value: SwitchValue | undefined;
  onPick: (choice: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label={sw.label} className="flex flex-wrap gap-1">
      {(sw.choices ?? []).map((choice) => (
        <Button
          key={choice}
          type="button"
          role="radio"
          aria-checked={value === choice}
          size="sm"
          variant={value === choice ? 'secondary' : 'outline'}
          onClick={() => onPick(choice)}
        >
          {choiceLabel(choice)}
        </Button>
      ))}
    </div>
  );
}

function ListControl({
  sw,
  value,
  accepted,
  onChange,
}: {
  sw: CatalogSwitch;
  value: SwitchValue | undefined;
  accepted: EditorProps['acceptedMethods'];
  onChange: (next: string | string[]) => void;
}) {
  const everything = value === ALL_ACCEPTED;
  const chosen = Array.isArray(value) ? value : [];
  const allId = useId();
  // The checklist offers the company's effective list, in the catalog's order of methods.
  const company = accepted?.data && Array.isArray(accepted.data.methods) ? accepted.data : undefined;
  const options = company ? (sw.listOptions ?? []).filter((o) => company.methods.includes(o)) : [];
  return (
    <div role="group" aria-label={sw.label} className="space-y-2">
      <div className="flex items-center gap-2">
        <Checkbox id={allId} checked={everything} onCheckedChange={(on) => onChange(on === true ? ALL_ACCEPTED : [])} />
        <label htmlFor={allId} className="text-sm">
          All accepted methods
        </label>
      </div>
      {company?.every_method && (
        <p className="text-muted-foreground text-xs">
          Your company hasn&apos;t chosen its accepted payment methods in Payments &amp; Lists, so every method is allowed.
        </p>
      )}
      {!everything &&
        (company ? (
          <ul className="grid grid-cols-1 gap-1 pl-6 sm:grid-cols-2">
            {options.map((option) => (
              <li key={option} className="flex items-center gap-2">
                <Checkbox
                  id={`${allId}-${option}`}
                  checked={chosen.includes(option)}
                  onCheckedChange={(on) => onChange(options.filter((o) => (o === option ? on === true : chosen.includes(o))))}
                />
                <label htmlFor={`${allId}-${option}`} className="text-sm">
                  {optionLabel(option)}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground pl-6 text-xs">
            {accepted?.isError
              ? "Your company's accepted payment methods can't be shown right now."
              : 'Loading the payment methods your company accepts...'}
          </p>
        ))}
    </div>
  );
}
