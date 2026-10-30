import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GripVertical, X } from 'lucide-react';

import {
  useOrganization,
  useStripeStatus,
  useRefreshStripeStatus,
  useUpdateOrganization,
  type DepositPolicy,
  type OrgFormValues,
  type PaymentMethod,
} from '@/lib/api/organization';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
// Owns the payout account's status states. The kit ships no equivalent, so it is reused whole and recorded in
// the ledger. Setup itself (terms, onboarding, bank and identity) lives on the owner-only payout account page.
import { PaymentsStatusCard } from '@/components/payments/PaymentsStatusCard';
// Owns its whole surface as well (the tag list, the inline rename/recolour editor
// and the delete confirm), so it is reused whole - but it draws its chrome from
// the same `Section` the ListSections below use, so it sits flush in their row.
import { TagsSettingsCard } from './components/tagsSettingsCard';
import { TaskCategoriesSettingsCard } from './components/taskCategoriesSettingsCard';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { ActionLink } from '@/components/ui/action-link';
import { MoveButtons } from '@/components/form/MoveButtons';
import { moveInList, type MoveDirection } from '@/lib/moveInList';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Switch } from '@/ui-kit/components/ui/switch';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { cn } from '@/ui-kit/lib/utils';

import { useSettingsBar } from './settingsBar';
import { Section } from './components/section';
import { InfoPopover } from '../_shared/infoPopover';
import { FieldErrorSummary, type FieldProblem } from './components/fieldErrorSummary';
import { jumpToField } from './components/jumpToField';
import { SettingRow } from './components/field';
import { LONG_TEXT_MAX } from '@/lib/textLimits';

type FormValues = Pick<
  OrgFormValues,
  | 'accepted_payment_methods'
  | 'source_options'
  | 'job_type_options'
  | 'deposit_default_type'
  | 'deposit_default_percentage'
  | 'deposit_default_fixed_amount'
  | 'card_offered_by_default'
  | 'bank_offered_by_default'
  | 'tips_enabled'
  | 'tip_presets'
  | 'deposit_policy'
  | 'bank_transfer_instructions'
>;

const DEPOSIT_POLICY_OPTIONS: ReadonlyArray<readonly [DepositPolicy, string]> = [
  ['REQUIRED_BEFORE_APPROVAL', 'Require the deposit before approval'],
  ['PAY_LATER', 'Allow approval now, deposit paid later'],
];

const TIP_RANGE_MESSAGE = 'Enter a whole number from 1 to 50.';
const TIP_DUPLICATE_MESSAGE = 'Each choice must be different.';
const DEPOSIT_PCT_MESSAGE = 'Enter a deposit percentage between 0 and 100.';
const DEPOSIT_FIXED_MESSAGE = 'Enter a valid fixed deposit amount (>= 0).';
const DEPOSIT_PCT_ID = 'deposit-pct';
const FIELD_LABELS: Record<string, string> = {
  'deposit-pct': 'Percentage',
  'deposit-fixed': 'Fixed amount',
  'tip-choice-1': 'Choice 1',
  'tip-choice-2': 'Choice 2',
  'tip-choice-3': 'Choice 3',
};
const DEPOSIT_FIXED_ID = 'deposit-fixed';

const tipFieldId = (i: number) => `tip-choice-${i + 1}`;
/** Reading order of every field that can fail a save: the first bad one is where the user is taken. */
const FIELD_ORDER = [DEPOSIT_PCT_ID, DEPOSIT_FIXED_ID, tipFieldId(0), tipFieldId(1), tipFieldId(2)];

/**
 * The backend's rule (organization.controller patchOrgSchema): three whole percentages, 1-50.
 * Returns the message for each bad box, keyed by its input id; a repeat is flagged on the later box.
 */
function tipPresetProblems(presets: number[]): Record<string, string> {
  const out: Record<string, string> = {};
  presets.forEach((n, i) => {
    if (!Number.isInteger(n) || n < 1 || n > 50) out[tipFieldId(i)] = TIP_RANGE_MESSAGE;
    else if (presets.findIndex((m) => m === n) !== i) out[tipFieldId(i)] = TIP_DUPLICATE_MESSAGE;
  });
  return out;
}

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
  // Payments go-live slice 16: an org whose plan lacks online payments is told so here, and is not
  // offered onboarding (the backend refuses to open a new account for it with 403). An org that
  // already has an account keeps its status card and "Fix now", so it can still get money it
  // already collected paid out; the plan message then sits beside the card.
  const onlinePaymentsInPlan = useFeature('online_payments');
  const { data: payStatus } = useStripeStatus();
  const hasPayoutAccount = Boolean(payStatus?.connected);
  const navigate = useNavigate();
  // Payments go-live slice 34: setting up and fixing the payout account is the owner's, on its own page.
  const canManagePayoutAccount = ability.can('manage_payout_account', 'Organization');
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const { registerSaver } = useSettingsBar();

  const form = useForm<FormValues>({ defaultValues: {} });
  const { reset, watch, setValue, getValues, formState, register } = form;

  const [newSource, setNewSource] = useState('');
  const [newJobType, setNewJobType] = useState('');
  // A failed save leaves one message per bad field, keyed by the field's input id.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const clearFieldError = (id: string) =>
    setFieldErrors((cur) => {
      if (!(id in cur)) return cur;
      const { [id]: _removed, ...rest } = cur;
      return rest;
    });

  // Back from the hosted onboarding (the return URL carries ?onboarding=return): re-read the
  // account status once, so the card shows what the account can do now, not what was stored.
  const [searchParams, setSearchParams] = useSearchParams();
  const { mutate: refreshStripeStatus } = useRefreshStripeStatus();
  const onboardingReturnHandled = useRef(false);
  useEffect(() => {
    if (onboardingReturnHandled.current || searchParams.get('onboarding') !== 'return') return;
    onboardingReturnHandled.current = true;
    refreshStripeStatus();
    const next = new URLSearchParams(searchParams);
    next.delete('onboarding');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, refreshStripeStatus]);

  // Hydrate once per org, and never over an edit in progress - the same guard
  // CompanyProfilePage carries, for the same reason and against the same query.
  // Hydrating on the DATA OBJECT hands the form back to the server mid-edit
  // whenever a refetch lands on a payload another admin has changed, and the
  // `reset()` that does it also takes `isDirty` to false, which SettingsLayout
  // publishes into the settings guard store - so the unsaved-changes prompt
  // stops asking and the loss is silent. Both halves matter: the dirty check is
  // what stops the clobber, keeping `org` as the dependency is what lets a
  // pristine form go on tracking the server (including the refetch after this
  // page's own save), and the id check stops the dirty guard wedging the form
  // onto a stale company if the org under the page ever changes identity.
  const hydratedOrgId = useRef<string | null>(null);

  useEffect(() => {
    const identityChanged = hydratedOrgId.current !== org?.id;
    if (!identityChanged && formState.isDirty) return;
    if (org) {
      hydratedOrgId.current = org.id;
      reset({
        accepted_payment_methods: org.accepted_payment_methods ?? [],
        source_options: org.source_options ?? [],
        job_type_options: org.job_type_options ?? [],
        deposit_default_type: org.deposit_default_type ?? 'PERCENTAGE',
        deposit_default_percentage: org.deposit_default_percentage ?? 50,
        deposit_default_fixed_amount: org.deposit_default_fixed_amount ?? 0,
        card_offered_by_default: org.card_offered_by_default ?? true,
        bank_offered_by_default: org.bank_offered_by_default ?? true,
        tips_enabled: org.tips_enabled ?? false,
        tip_presets: org.tip_presets ?? [10, 15, 20],
        deposit_policy: org.deposit_policy ?? 'REQUIRED_BEFORE_APPROVAL',
        bank_transfer_instructions: org.bank_transfer_instructions ?? '',
      });
    }
    // `isDirty` is read, not depended on: it is a getter on RHF's formState
    // Proxy, and listing it would re-arm this effect on every dirty flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, reset]);

  const isDirty = formState.isDirty;

  /** The failed fields among `ids`, in reading order, for a card's "Fix N fields" banner. */
  const problemsFor = (ids: string[]): FieldProblem[] =>
    ids.filter((id) => id in fieldErrors).map((id) => ({ id, label: FIELD_LABELS[id] ?? id }));

  useEffect(() => {
    registerSaver({
      save: async () => {
        const values = getValues();
        const payload = dirtyValues(formState.dirtyFields as Record<string, unknown>, values as Record<string, unknown>);
        const depositType = values.deposit_default_type;
        const depositPct = Number(values.deposit_default_percentage);
        const depositFixed = Number(values.deposit_default_fixed_amount);
        // Every bad field is collected, so the page can mark each one and take the user to the first.
        const problems: Record<string, string> = {};
        if (depositType === 'PERCENTAGE' && (Number.isNaN(depositPct) || depositPct < 0 || depositPct > 100)) {
          problems[DEPOSIT_PCT_ID] = DEPOSIT_PCT_MESSAGE;
        }
        if (depositType === 'FIXED' && (Number.isNaN(depositFixed) || depositFixed < 0)) {
          problems[DEPOSIT_FIXED_ID] = DEPOSIT_FIXED_MESSAGE;
        }
        // The choices are only on screen while tips are on. Edited and then hidden, they are held to the
        // same rule only when they would still be sent; a bad hidden set is simply not sent.
        if ('tip_presets' in payload) {
          const bad = tipPresetProblems(values.tip_presets ?? []);
          if (values.tips_enabled) Object.assign(problems, bad);
          else if (Object.keys(bad).length) delete payload.tip_presets;
        }
        setFieldErrors(problems);
        const first = FIELD_ORDER.find((id) => id in problems);
        if (first) {
          jumpToField(first);
          const err = new Error('Fix the highlighted fields to save');
          err.name = 'FieldErrors';
          throw err;
        }
        if (Object.keys(payload).length) await update.mutateAsync(payload as Partial<OrgFormValues>);
        reset(values);
      },
      discard: () => {
        if (org) reset();
        setFieldErrors({});
      },
      isDirty,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  const methods = (watch('accepted_payment_methods') as PaymentMethod[] | undefined) ?? [];
  // What the payout account can take today, the same facts the backend resolver keys on: CARD and
  // ACH in the accepted methods are server-owned capability mirrors, and neither works while
  // charges are off. Read from the org, never from the form, which only echoes them back.
  const chargesOn = org?.stripe_charges_enabled === true;
  const canTakeCards = chargesOn && (org?.accepted_payment_methods ?? []).includes('CARD');
  const canTakeBank = chargesOn && (org?.accepted_payment_methods ?? []).includes('ACH');
  const onlineGroupId = useId();
  const manualGroupId = useId();
  const sources = (watch('source_options') as string[] | undefined) ?? [];
  const jobTypes = (watch('job_type_options') as string[] | undefined) ?? [];
  const depositType = watch('deposit_default_type') ?? 'PERCENTAGE';
  const depositPolicy = watch('deposit_policy') ?? 'REQUIRED_BEFORE_APPROVAL';
  const tipsEnabled = watch('tips_enabled') ?? false;
  const tipPresets = watch('tip_presets') ?? [10, 15, 20];

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
      {/* ServWave Payments status card (6.1). Its button hands the owner to the payout account page;
          anyone else sees the status only. */}
      {(onlinePaymentsInPlan || hasPayoutAccount) && (
        <PaymentsStatusCard onOpenSetup={canManagePayoutAccount ? () => navigate('/settings/payout-account') : undefined} />
      )}
      {!onlinePaymentsInPlan && <OnlinePaymentsNotInPlan besideAccount={hasPayoutAccount} />}

      {/* Payments row */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Section title="Accepted Payment Methods">
          {/* Online methods: CARD and ACH in accepted_payment_methods are server-owned capability
              facts (the payout account can take them), so these switches save the owner's DEFAULT
              offer of each in its own field and never edit that list. */}
          <div role="group" aria-labelledby={onlineGroupId} className="space-y-3 rounded-md border p-3">
            <p id={onlineGroupId} className="text-xs font-medium">Online with ServWave Payments</p>
            <OnlineMethodRow
              label="Credit card"
              available={onlinePaymentsInPlan && canTakeCards}
              unavailableReason={onlinePaymentsInPlan ? ONLINE_UNAVAILABLE_REASON : NOT_IN_PLAN_REASON}
              checked={watch('card_offered_by_default') ?? true}
              onCheckedChange={(v) => setValue('card_offered_by_default', v, { shouldDirty: true })}
            />
            <OnlineMethodRow
              label="Bank (ACH)"
              available={onlinePaymentsInPlan && canTakeBank}
              unavailableReason={onlinePaymentsInPlan ? ONLINE_UNAVAILABLE_REASON : NOT_IN_PLAN_REASON}
              checked={watch('bank_offered_by_default') ?? true}
              onCheckedChange={(v) => setValue('bank_offered_by_default', v, { shouldDirty: true })}
            />
          </div>
          <div role="group" aria-labelledby={manualGroupId} className="space-y-2">
            <p id={manualGroupId} className="text-xs font-medium">Recorded by hand</p>
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

        <Section title="Default Deposit">
          <div className="space-y-3">
            <FieldErrorSummary problems={problemsFor([DEPOSIT_PCT_ID, DEPOSIT_FIXED_ID])} />
            <div className="space-y-1.5">
              <p className="text-xs font-medium">When the deposit is paid</p>
              <div role="radiogroup" aria-label="Deposit policy" className="flex flex-col items-start gap-2">
                {DEPOSIT_POLICY_OPTIONS.map(([value, label]) => (
                  <Button
                    key={value}
                    role="radio"
                    size="sm"
                    variant={depositPolicy === value ? 'secondary' : 'outline'}
                    aria-checked={depositPolicy === value}
                    onClick={() => setValue('deposit_policy', value, { shouldDirty: true })}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
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
                <Label htmlFor={DEPOSIT_PCT_ID} className="text-xs">Percentage (0-100)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id={DEPOSIT_PCT_ID}
                    kind="percent"
                    min={0}
                    max={100}
                    step="0.5"
                    value={watch('deposit_default_percentage') ?? 50}
                    onChange={(e) => {
                      setValue('deposit_default_percentage', Number(e.target.value), { shouldDirty: true });
                      clearFieldError(DEPOSIT_PCT_ID);
                    }}
                    className={cn('w-28', DEPOSIT_PCT_ID in fieldErrors && 'border-danger')}
                    aria-invalid={DEPOSIT_PCT_ID in fieldErrors}
                    aria-describedby={DEPOSIT_PCT_ID in fieldErrors ? `${DEPOSIT_PCT_ID}-error` : undefined}
                  />
                  <span className="text-muted-foreground text-sm">%</span>
                </div>
                <FieldMessage id={`${DEPOSIT_PCT_ID}-error`} message={fieldErrors[DEPOSIT_PCT_ID]} />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor={DEPOSIT_FIXED_ID} className="text-xs">Fixed amount</Label>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">$</span>
                  <Input
                    id={DEPOSIT_FIXED_ID}
                    kind="money"
                    min={0}
                    step="0.01"
                    value={watch('deposit_default_fixed_amount') ?? 0}
                    onChange={(e) => {
                      setValue('deposit_default_fixed_amount', Number(e.target.value), { shouldDirty: true });
                      clearFieldError(DEPOSIT_FIXED_ID);
                    }}
                    className={cn('w-28', DEPOSIT_FIXED_ID in fieldErrors && 'border-danger')}
                    aria-invalid={DEPOSIT_FIXED_ID in fieldErrors}
                    aria-describedby={DEPOSIT_FIXED_ID in fieldErrors ? `${DEPOSIT_FIXED_ID}-error` : undefined}
                  />
                </div>
                <FieldMessage id={`${DEPOSIT_FIXED_ID}-error`} message={fieldErrors[DEPOSIT_FIXED_ID]} />
              </div>
            )}
          </div>
        </Section>
      </div>

      {/* Tips (org-level only, PRD call 6) */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Section
          title="Tips"
          info={<InfoPopover label="Tips">Customers can also enter their own amount or skip the tip.</InfoPopover>}
        >
          <FieldErrorSummary problems={problemsFor([tipFieldId(0), tipFieldId(1), tipFieldId(2)])} />
          <SettingRow
            title="Let customers add a tip"
            control={
              <Switch
                aria-label="Let customers add a tip"
                checked={tipsEnabled}
                onCheckedChange={(v) => setValue('tips_enabled', v, { shouldDirty: true })}
              />
            }
          />
          {tipsEnabled && (
            <div data-testid="tip-presets-row" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((i) => {
                const id = tipFieldId(i);
                const bad = id in fieldErrors;
                return (
                  <div key={id} className="flex flex-col gap-1.5">
                    <Label htmlFor={id} className="text-xs">{`Choice ${i + 1}`}</Label>
                    <Input
                      id={id}
                      kind="count"
                      endIcon="%"
                      value={Number.isNaN(tipPresets[i]) ? '' : tipPresets[i]}
                      onValueChange={(n) => {
                        const next = [...tipPresets];
                        next[i] = n ?? Number.NaN;
                        setValue('tip_presets', next, { shouldDirty: true });
                        // A duplicate depends on the other boxes, so any edit retires all the tip messages.
                        setFieldErrors((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith('tip-choice-'))));
                      }}
                      // aria-invalid:border-destructive emits no CSS in this build; draw it explicitly.
                      className={cn(bad && 'border-danger')}
                      aria-invalid={bad}
                      aria-describedby={bad ? `${id}-error` : undefined}
                    />
                    <FieldMessage id={`${id}-error`} message={fieldErrors[id]} />
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        <Section
          title="Bank-transfer instructions"
          info={(
            <InfoPopover label="Bank-transfer instructions">
              Transfers are not tracked automatically. When a transfer arrives, record the payment on the invoice yourself.
            </InfoPopover>
          )}
        >
          <div className="space-y-1.5">
            <Label htmlFor="bank-transfer-instructions" className="sr-only">
              Bank-transfer instructions
            </Label>
            <Textarea
              id="bank-transfer-instructions"
              rows={4}
              maxLength={LONG_TEXT_MAX}
              placeholder="Account name, routing and account numbers, and the reference to use"
              {...register('bank_transfer_instructions')}
            />
          </div>
        </Section>
      </div>

      {/* Lists row */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <ListSection
          title="Lead/Customer Sources"
          help="Changing this doesn't affect saved records."
          items={sources}
          value={newSource}
          onValueChange={setNewSource}
          onAdd={() => addToList('source_options', newSource, () => setNewSource(''))}
          onRemove={(v) => removeFromList('source_options', v)}
          placeholder="New source"
        />
        <ListSection
          title="Job Types"
          help="Changing this doesn't affect saved records."
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

const ONLINE_UNAVAILABLE_REASON = 'Finish payout account verification first.';
const NOT_IN_PLAN_REASON = 'Not included in your plan.';

/**
 * The plan message for an org whose plan lacks online payments. With no payout account it stands
 * in place of the status card, so the owner learns it before starting onboarding rather than
 * part-way through. Beside an existing account it explains why customers can't pay online while
 * the account itself stays fixable. The upgrade path is the one the upgrade page offers: a message
 * to ServWave support.
 */
function OnlinePaymentsNotInPlan({ besideAccount }: { besideAccount: boolean }) {
  return (
    <Section title={besideAccount ? 'Your plan' : 'ServWave Payments'}>
      <p className="text-sm">Online payments aren&apos;t included in your plan.</p>
      {besideAccount && (
        <p className="text-sm text-text-secondary">
          Customers can&apos;t pay online right now. You can still keep your payout account up to date.
        </p>
      )}
      <div>
        <ActionLink variant="outline" href="mailto:support@servwave.com?subject=ServWave plan upgrade">
          Contact us to upgrade
        </ActionLink>
      </div>
    </Section>
  );
}

/**
 * One online method's default offer (Card or Bank). While the payout account cannot take the
 * method the switch is disabled and the row reads "Unavailable" with the reason, so it never looks
 * like the owner switched it off. The switch keeps the saved preference, which applies once the
 * capability turns on.
 */
function OnlineMethodRow({
  label,
  available,
  unavailableReason,
  checked,
  onCheckedChange,
}: {
  label: string;
  available: boolean;
  unavailableReason: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const reasonId = useId();
  return (
    <SettingRow
      title={
        <span className="inline-flex items-center gap-2">
          {label}
          {!available && (
            <Badge variant="softNeutral" size="sm">
              Unavailable
            </Badge>
          )}
        </span>
      }
      hint={available ? undefined : <span id={reasonId}>{unavailableReason}</span>}
      control={
        <Switch
          aria-label={label}
          aria-describedby={available ? undefined : reasonId}
          disabled={!available}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      }
    />
  );
}

/** The message under a bad field, in the field's own words. Renders nothing when the field is fine. */
function FieldMessage({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-danger text-xs">
      {message}
    </p>
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

  // Move up / Move down (mobile slice 48): one step, handed to the same onReorder a drag uses.
  const moveOpt = (index: number, direction: MoveDirection) => {
    const next = moveInList(items, index, direction);
    if (next) onReorder?.(next);
  };

  return (
    <Section title={title} info={<InfoPopover label={title}>{help}</InfoPopover>}>
      <div className="flex min-h-[28px] flex-wrap gap-2">
        {items.length > 0 ? (
          items.map((opt, index) => (
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
              {onReorder && (
                <MoveButtons
                  compact
                  name={opt}
                  canMoveUp={index > 0}
                  canMoveDown={index < items.length - 1}
                  onMoveUp={() => moveOpt(index, 'up')}
                  onMoveDown={() => moveOpt(index, 'down')}
                />
              )}
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
