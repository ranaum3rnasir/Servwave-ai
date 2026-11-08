import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Check, GripVertical, X } from 'lucide-react';

import {
  useOrganization,
  useUpdateOrganization,
  type OrgFormValues,
  type PaymentMethod,
} from '@/lib/api/organization';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
// Both own their entire surface (Stripe account state, the onboarding steps and
// the Connect handshake). The kit ships no equivalent, so they are reused whole
// and recorded in the ledger.
import { StripePaymentsStatusCard } from '@/components/payments/StripePaymentsStatusCard';
import { StripeOnboardingDrawer } from '@/components/payments/StripeOnboardingDrawer';
// Owns its whole surface as well (the tag list, the inline rename/recolour editor
// and the delete confirm), so it is reused whole - but it draws its chrome from
// the same `Section` the ListSections below use, so it sits flush in their row.
import { TagsSettingsCard } from './components/tagsSettingsCard';
import { TaskCategoriesSettingsCard } from './components/taskCategoriesSettingsCard';
import { useAppAbility } from '@/contexts/AbilityContext';

import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { cn } from '@/ui-kit/lib/utils';

import { useSettingsBar } from './settingsBar';
import { Section } from './components/section';

type FormValues = Pick<OrgFormValues, 'accepted_payment_methods' | 'source_options' | 'job_type_options' | 'deposit_default_type' | 'deposit_default_percentage' | 'deposit_default_fixed_amount'>;

function dirtyValues(dirtyFields: Record<string, unknown>, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(dirtyFields)) {
    if (dirtyFields[k]) out[k] = values[k];
  }
  return out;
}

/**
 * Settings > Payments & Lists.
 *
 * Deposit validation runs INSIDE `save`, not through a resolver, and it throws a
 * plain `Error` rather than a `ValidationError` - which the settings shell
 * deliberately swallows, so the user sees only the inline red text and the Save
 * bar simply stops. That is arguably a UX bug; it is carried over verbatim and
 * logged in the ledger rather than fixed here.
 */
export default function PaymentsListsPage() {
  const ability = useAppAbility();
  // `update`/`delete Tag` carry no defaultGrants row, so this is ADMIN-only.
  const canManageTags = ability.can('update', 'Tag') && ability.can('delete', 'Tag');
  // `create`/`update TaskCategory` carry no defaultGrants row either: ADMIN-only.
  const canManageTaskCategories = ability.can('create', 'TaskCategory') && ability.can('update', 'TaskCategory');
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const { registerSaver } = useSettingsBar();

  const form = useForm<FormValues>({ defaultValues: {} });
  const { reset, watch, setValue, getValues, formState } = form;

  const [newSource, setNewSource] = useState('');
  const [newJobType, setNewJobType] = useState('');
  const [depositError, setDepositError] = useState<string | null>(null);
  const [payDrawerOpen, setPayDrawerOpen] = useState(false);

  useEffect(() => {
    if (org) {
      reset({
        accepted_payment_methods: org.accepted_payment_methods ?? [],
        source_options: org.source_options ?? [],
        job_type_options: org.job_type_options ?? [],
        deposit_default_type: org.deposit_default_type ?? 'PERCENTAGE',
        deposit_default_percentage: org.deposit_default_percentage ?? 50,
        deposit_default_fixed_amount: org.deposit_default_fixed_amount ?? 0,
      });
    }
  }, [org, reset]);

  const isDirty = formState.isDirty;

  useEffect(() => {
    registerSaver({
      save: async () => {
        const values = getValues();
        const payload = dirtyValues(formState.dirtyFields as Record<string, unknown>, values as Record<string, unknown>);
        const depositType = values.deposit_default_type;
        const depositPct = Number(values.deposit_default_percentage);
        const depositFixed = Number(values.deposit_default_fixed_amount);
        if (depositType === 'PERCENTAGE' && (Number.isNaN(depositPct) || depositPct < 0 || depositPct > 100)) {
          setDepositError('Enter a deposit percentage between 0 and 100.');
          throw new Error('Invalid deposit percentage');
        }
        if (depositType === 'FIXED' && (Number.isNaN(depositFixed) || depositFixed < 0)) {
          setDepositError('Enter a valid fixed deposit amount (>= 0).');
          throw new Error('Invalid deposit fixed amount');
        }
        setDepositError(null);
        if (Object.keys(payload).length) await update.mutateAsync(payload as Partial<OrgFormValues>);
        reset(values);
      },
      discard: () => {
        if (org) reset();
        setDepositError(null);
      },
      isDirty,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  const methods = (watch('accepted_payment_methods') as PaymentMethod[] | undefined) ?? [];
  const sources = (watch('source_options') as string[] | undefined) ?? [];
  const jobTypes = (watch('job_type_options') as string[] | undefined) ?? [];
  const depositType = watch('deposit_default_type') ?? 'PERCENTAGE';

  const addToList = (key: 'source_options' | 'job_type_options', value: string, clear: () => void) => {
    const v = value.trim();
    if (!v) return;
    const cur = (getValues(key) as string[] | undefined) ?? [];
    if (!cur.some((o) => o.toLowerCase() === v.toLowerCase())) {
      setValue(key, [...cur, v], { shouldDirty: true });
    }
    clear();
  };
  const removeFromList = (key: 'source_options' | 'job_type_options', value: string) =>
    setValue(key, ((getValues(key) as string[] | undefined) ?? []).filter((o) => o !== value), { shouldDirty: true });

  return (
    <div className="space-y-6">
      {/* ServWave Payments status card (6.1) + its onboarding drawer (Task 2.4). This
          page owns the drawer's open state; the card never imports the drawer itself. */}
      <StripePaymentsStatusCard onOpenDrawer={() => setPayDrawerOpen(true)} />
      <StripeOnboardingDrawer open={payDrawerOpen} onOpenChange={setPayDrawerOpen} />

      {/* Payments row */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Section
          title="Accepted Payment Methods"
          description="Shown to customers on public estimate & invoice pages. Dispatchers can narrow this per estimate."
        >
          <div className="space-y-2">
            {/* CARD is not a manual toggle here - card acceptance is governed entirely by
                ServWave Payments (Stripe) connection status, not by dispatchers checking a
                box. Once charges are live, show a read-only confirmation row instead: the
                status card above only says "payouts enabled," which doesn't tell a
                contractor whether customers can actually pay by card on their invoices. */}
            {org?.stripe_charges_enabled && (
              <div className="border-brand bg-brand-subtle flex items-center gap-3 rounded-md border p-3">
                <Check aria-hidden className="text-brand size-4 shrink-0" />
                <div>
                  <span className="text-sm">ServWave Payments</span>
                  <p className="text-muted-foreground text-xs">
                    Accepted automatically - customers can pay by card.
                  </p>
                </div>
              </div>
            )}
            {PAYMENT_METHOD_ORDER.filter((method) => method !== 'CARD').map((method) => {
              const checked = methods.includes(method);
              return (
                <Label
                  key={method}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md border p-3 font-normal',
                    checked ? 'border-brand bg-brand-subtle' : 'border-border',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => {
                      const list = next === true
                        ? [...methods.filter((m) => m !== method), method]
                        : methods.filter((m) => m !== method);
                      setValue('accepted_payment_methods', list as PaymentMethod[], { shouldDirty: true });
                    }}
                  />
                  <span className="text-sm">{PAYMENT_METHOD_LABELS[method]}</span>
                </Label>
              );
            })}
          </div>
        </Section>

        <Section
          title="Default Deposit"
          description="Default deposit when sending or recording payment on an estimate. Dispatchers can override per estimate."
        >
          <div className="space-y-3">
            {/* The kit ships no RadioGroup, so the pair is two `aria-checked`
                buttons inside a `radiogroup` - the same shape the customers
                module built for its own radio rows. */}
            <div role="radiogroup" aria-label="Default deposit type" className="flex gap-3">
              {(
                [
                  ['PERCENTAGE', 'Percentage'],
                  ['FIXED', 'Fixed amount'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  role="radio"
                  size="sm"
                  variant={depositType === value ? 'secondary' : 'outline'}
                  aria-checked={depositType === value}
                  onClick={() => setValue('deposit_default_type', value, { shouldDirty: true })}
                >
                  {label}
                </Button>
              ))}
            </div>
            {depositType === 'PERCENTAGE' ? (
              <div className="space-y-1.5">
                <Label htmlFor="deposit-pct" className="text-xs">Percentage (0-100)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="deposit-pct"
                    type="number"
                    min={0}
                    max={100}
                    step="0.5"
                    value={watch('deposit_default_percentage') ?? 50}
                    onChange={(e) => {
                      setValue('deposit_default_percentage', Number(e.target.value), { shouldDirty: true });
                      setDepositError(null);
                    }}
                    className="w-28"
                    aria-invalid={!!depositError}
                  />
                  <span className="text-muted-foreground text-sm">%</span>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="deposit-fixed" className="text-xs">Fixed amount</Label>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">$</span>
                  <Input
                    id="deposit-fixed"
                    type="number"
                    min={0}
                    step="0.01"
                    value={watch('deposit_default_fixed_amount') ?? 0}
                    onChange={(e) => {
                      setValue('deposit_default_fixed_amount', Number(e.target.value), { shouldDirty: true });
                      setDepositError(null);
                    }}
                    className="w-28"
                    aria-invalid={!!depositError}
                  />
                </div>
              </div>
            )}
            {depositError && <p className="text-destructive text-xs">{depositError}</p>}
          </div>
        </Section>
      </div>

      {/* Lists row */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ListSection
          title="Lead/Customer Sources"
          help="Shown when creating or editing a customer or lead (e.g. Google, Referral). Changing this doesn't affect saved records."
          items={sources}
          value={newSource}
          onValueChange={setNewSource}
          onAdd={() => addToList('source_options', newSource, () => setNewSource(''))}
          onRemove={(v) => removeFromList('source_options', v)}
          placeholder="New source"
        />
        <ListSection
          title="Job Types"
          help="Shown when creating or editing a lead. Changing this doesn't affect saved records."
          items={jobTypes}
          value={newJobType}
          onValueChange={setNewJobType}
          onAdd={() => addToList('job_type_options', newJobType, () => setNewJobType(''))}
          onRemove={(v) => removeFromList('job_type_options', v)}
          onReorder={(next) => setValue('job_type_options', next, { shouldDirty: true })}
          placeholder="New job type"
        />
        {canManageTags && <TagsSettingsCard />}
        {canManageTaskCategories && <TaskCategoriesSettingsCard />}
      </div>
    </div>
  );
}

function ListSection({
  title,
  help,
  items,
  value,
  onValueChange,
  onAdd,
  onRemove,
  onReorder,
  placeholder,
}: {
  title: string;
  help: string;
  items: string[];
  value: string;
  onValueChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (v: string) => void;
  onReorder?: (next: string[]) => void;
  placeholder: string;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const handleDrop = (src: string, target: string) => {
    const from = items.indexOf(src);
    const to = items.indexOf(target);
    if (from === -1 || to === -1 || from === to) return;
    const next = [...items];
    next.splice(from, 1);
    next.splice(to, 0, src);
    onReorder?.(next);
  };

  return (
    <Section title={title} description={help}>
      <div className="flex min-h-[28px] flex-wrap gap-2">
        {items.length > 0 ? (
          items.map((opt) => (
            <span
              key={opt}
              draggable={!!onReorder}
              onDragStart={(e) => {
                setDragging(opt);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', opt);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (dragging && dragging !== opt) {
                  e.preventDefault();
                  setOver(opt);
                }
              }}
              onDragLeave={() => setOver((c) => (c === opt ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                const src = e.dataTransfer.getData('text/plain') || dragging;
                if (src && src !== opt) handleDrop(src, opt);
                setDragging(null);
                setOver(null);
              }}
              className={cn(
                'bg-muted inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium',
                onReorder && 'cursor-grab active:cursor-grabbing',
                dragging === opt && 'opacity-40',
                // The drop target reads as a selected row rather than an outline
                // ring: not every token has a generated ring utility in this
                // theme, and the unresolved-classes guard counts the ones that
                // do not. (Written without naming the utility prefix on purpose
                // - that scanner reads raw source text, comments included.)
                over === opt && 'bg-selected',
              )}
            >
              {onReorder && <GripVertical aria-hidden className="text-muted-foreground -ml-0.5 size-3" />}
              {opt}
              {/* A kit Button, not a raw <button>: the raw-tag ratchet sits at its
                  floor and a chip's close affordance is still a control. */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${opt}`}
                className="ml-0.5 size-5"
                onClick={() => onRemove(opt)}
              >
                <X />
              </Button>
            </span>
          ))
        ) : (
          <EmptyState title="No options - add some below." />
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAdd();
            }
          }}
          placeholder={`${placeholder} (press Enter or Add)`}
          className="flex-1"
          maxLength={50}
        />
        <Button type="button" size="sm" onClick={onAdd} disabled={!value.trim()}>
          Add
        </Button>
      </div>
    </Section>
  );
}
