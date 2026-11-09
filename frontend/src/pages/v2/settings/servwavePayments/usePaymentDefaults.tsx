import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { useFeature } from '@/lib/entitlements';
import { useAuthStore } from '@/stores/auth.store';

import {
  useOrganization,
  useUpdateOrganization,
  type DepositPolicy,
  type OrgFormValues,
  type PaymentMethod,
} from '@/lib/api/shared/organization';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
import { NewTabLink } from '@/components/ui/new-tab-link';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Switch } from '@/ui-kit/components/ui/switch';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { cn } from '@/ui-kit/lib/utils';

import { InfoPopover } from '../../_shared/infoPopover';
import { FieldErrorSummary, type FieldProblem } from '../components/fieldErrorSummary';
import { jumpToField } from '../components/jumpToField';
import { Section } from '../components/section';
import { useSettingsBar } from '../settingsBar';

type FormValues = Pick<
  OrgFormValues,
  | 'accepted_payment_methods'
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
const DEPOSIT_FIXED_MESSAGE = 'Enter a fixed deposit amount of $0.00 or more.';
const BANK_LENGTH_MESSAGE = 'Use 5,000 characters or fewer.';
const BANK_MAX = 5000;
const DEPOSIT_FIXED_MAX = 99_999_999;

const DEPOSIT_PCT_ID = 'deposit-pct';
const DEPOSIT_FIXED_ID = 'deposit-fixed';
const BANK_ID = 'bank-transfer-instructions';
const tipFieldId = (i: number) => `tip-choice-${i + 1}`;
const FIELD_LABELS: Record<string, string> = {
  [DEPOSIT_PCT_ID]: 'Percentage',
  [DEPOSIT_FIXED_ID]: 'Fixed amount',
  'tip-choice-1': 'Tip choice 1',
  'tip-choice-2': 'Tip choice 2',
  'tip-choice-3': 'Tip choice 3',
  [BANK_ID]: 'Instructions customers see',
};
/** Reading order of every field that can fail a save: the first bad one is where the user is taken. */
const FIELD_ORDER = [DEPOSIT_PCT_ID, DEPOSIT_FIXED_ID, tipFieldId(0), tipFieldId(1), tipFieldId(2), BANK_ID];

const ONLINE_UNAVAILABLE_REASON = 'Finish payout account verification first.';
const NOT_IN_PLAN_REASON = 'Not included in your plan.';

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

/** The message under a bad field, in the field's own words. Renders nothing when the field is fine. */
function FieldMessage({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-danger text-xs">
      {message}
    </p>
  );
}

/** A number box with its unit chip glued to one side (the % or $ of the mockup). */
function Adorned({ side, unit, children }: { side: 'left' | 'right'; unit: string; children: ReactNode }) {
  const chip = (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex items-center border border-input bg-muted px-2.5 font-semibold text-text-secondary',
        side === 'left' ? 'rounded-l-md border-r-0' : 'rounded-r-md border-l-0',
      )}
    >
      {unit}
    </span>
  );
  return (
    <div className="flex items-stretch [&_[data-slot=input]]:text-right">
      {side === 'left' && chip}
      {children}
      {side === 'right' && chip}
    </div>
  );
}

const PILL = 'h-11 rounded-full px-4 font-semibold';

function PillRadios<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
  onChange: (next: T) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-xs font-medium">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-wrap gap-2">
        {options.map(([v, text]) => (
          <Button
            key={v}
            type="button"
            role="radio"
            variant={value === v ? 'secondary' : 'outline'}
            aria-checked={value === v}
            className={cn(PILL, value === v && 'border-brand')}
            onClick={() => onChange(v)}
          >
            {text}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * One online method's default offer (Card or Bank). While the payout account cannot take the method the switch
 * stays focusable but inert (aria-disabled) and the row reads "Unavailable" with the reason, so it never looks like
 * the owner switched it off. The switch keeps the saved preference, which applies once the capability turns on.
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
  const labelId = useId();
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span id={labelId}>{label}</span>
          {!available && (
            <Badge variant="softNeutral">
              Unavailable
            </Badge>
          )}
        </span>
        {!available && (
          <span id={reasonId} className="text-[12.5px] text-text-secondary">
            {unavailableReason}
          </span>
        )}
      </div>
      <Switch
        aria-labelledby={labelId}
        aria-describedby={available ? undefined : reasonId}
        aria-disabled={!available}
        checked={checked}
        onCheckedChange={(v) => {
          if (available) onCheckedChange(v);
        }}
      />
    </div>
  );
}

/**
 * Cards 3 to 7 of Settings > ServWave Payments and the form behind them. Only mounted for someone who may change
 * company settings: it registers the shell's Save bar saver, so a page without these cards has no Save bar.
 *
 * Validation runs INSIDE `save`, not through a resolver, and it throws a plain `Error` named `FieldErrors`, which
 * the settings shell swallows: the person sees the inline red text and the summary, and the Save bar simply stops.
 */
export function usePaymentDefaults(): { summary: ReactNode; cards: ReactNode } {
  const onlinePaymentsInPlan = useFeature('online_payments');
  // The bank-transfer instructions are an Admin's alone (M8, D3): the server refuses a save that carries them from anyone else,
  // so for anyone else the card is not drawn and the field is never sent.
  const isAdmin = useAuthStore((s) => s.user?.is_admin === true);
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const { registerSaver } = useSettingsBar();

  const form = useForm<FormValues>({ defaultValues: {} });
  const { reset, watch, setValue, getValues, formState, register } = form;

  // A failed save leaves one message per bad field, keyed by the field's input id.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const clearFieldError = (id: string) =>
    setFieldErrors((cur) => {
      if (!(id in cur)) return cur;
      const { [id]: _removed, ...rest } = cur;
      return rest;
    });

  // Hydrate once per org, and never over an edit in progress. Hydrating on the DATA OBJECT hands the form back to
  // the server mid-edit whenever a refetch lands on a payload another admin has changed, and the `reset()` that
  // does it also takes `isDirty` to false, which SettingsLayout publishes into the settings guard store - so the
  // unsaved-changes prompt stops asking and the loss is silent. Keeping `org` as the dependency lets a pristine
  // form go on tracking the server (including the refetch after this page's own save).
  const hydratedOrgId = useRef<string | null>(null);
  useEffect(() => {
    const identityChanged = hydratedOrgId.current !== org?.id;
    if (!identityChanged && formState.isDirty) return;
    if (org) {
      hydratedOrgId.current = org.id;
      reset({
        accepted_payment_methods: org.accepted_payment_methods ?? [],
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
    // `isDirty` is read, not depended on: it is a getter on RHF's formState Proxy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Every bad field is collected, so the page can mark each one and take the user to the first.
        const problems: Record<string, string> = {};
        if (depositType === 'PERCENTAGE' && (Number.isNaN(depositPct) || depositPct < 0 || depositPct > 100)) {
          problems[DEPOSIT_PCT_ID] = DEPOSIT_PCT_MESSAGE;
        }
        if (depositType === 'FIXED' && (Number.isNaN(depositFixed) || depositFixed < 0 || depositFixed > DEPOSIT_FIXED_MAX)) {
          problems[DEPOSIT_FIXED_ID] = DEPOSIT_FIXED_MESSAGE;
        }
        // The choices are only on screen while tips are on. Edited and then hidden, they are held to the
        // same rule only when they would still be sent; a bad hidden set is simply not sent.
        if ('tip_presets' in payload) {
          const bad = tipPresetProblems(values.tip_presets ?? []);
          if (values.tips_enabled) Object.assign(problems, bad);
          else if (Object.keys(bad).length) delete payload.tip_presets;
        }
        if (!isAdmin) delete payload.bank_transfer_instructions;
        else if ((values.bank_transfer_instructions ?? '').length > BANK_MAX) problems[BANK_ID] = BANK_LENGTH_MESSAGE;
        // The amount field that is not on screen is held to no rule: a bad value left behind in it is not sent.
        const badNumber = (v: unknown) => typeof v !== 'number' || Number.isNaN(v);
        if (depositType === 'FIXED' && 'deposit_default_percentage' in payload && badNumber(payload.deposit_default_percentage)) {
          delete payload.deposit_default_percentage;
        }
        if (depositType === 'PERCENTAGE' && 'deposit_default_fixed_amount' in payload && badNumber(payload.deposit_default_fixed_amount)) {
          delete payload.deposit_default_fixed_amount;
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
  // What the payout account can take today, the same facts the backend resolver keys on: CARD and ACH in the
  // accepted methods are server-owned capability mirrors, and neither works while charges are off. Read from the
  // org, never from the form, which only echoes them back.
  const chargesOn = org?.stripe_charges_enabled === true;
  const canTakeCards = chargesOn && (org?.accepted_payment_methods ?? []).includes('CARD');
  const canTakeBank = chargesOn && (org?.accepted_payment_methods ?? []).includes('ACH');
  const unavailableReason = onlinePaymentsInPlan ? ONLINE_UNAVAILABLE_REASON : NOT_IN_PLAN_REASON;
  const handGroupId = useId();
  const onlineGroupId = useId();
  const depositType = watch('deposit_default_type') ?? 'PERCENTAGE';
  const depositPolicy = watch('deposit_policy') ?? 'REQUIRED_BEFORE_APPROVAL';
  const depositPct = watch('deposit_default_percentage') ?? 50;
  const depositFixed = watch('deposit_default_fixed_amount') ?? 0;
  const tipsEnabled = watch('tips_enabled') ?? false;
  const tipPresets = watch('tip_presets') ?? [10, 15, 20];
  const bankText = watch('bank_transfer_instructions') ?? '';

  const problems: FieldProblem[] = FIELD_ORDER.filter((id) => id in fieldErrors).map((id) => ({
    id,
    label: FIELD_LABELS[id] ?? id,
  }));
  const summary = problems.length >= 2 ? <FieldErrorSummary
        problems={problems}
        messages={Object.fromEntries(problems.map((p) => [p.id, `${p.label}: ${fieldErrors[p.id]}`]))}
      /> : null;

  const bankRegister = register('bank_transfer_instructions');
  const bankBad = BANK_ID in fieldErrors || bankText.length > BANK_MAX;

  const numberValue = (n: number) => (Number.isNaN(n) ? '' : n);

  const cards = (
    <>
      <div id="sec-methods">
        <Section
          title="Accepted payment methods"
          info={
            <InfoPopover label="Accepted payment methods">
              The ways customers can pay an invoice. Card and bank (ACH) are paid online through ServWave Payments. The rest are payments you record by hand.
            </InfoPopover>
          }
        >
          <div className="flex flex-col gap-4">
            {/* CARD and ACH in accepted_payment_methods are server-owned capability facts (the payout account
                can take them), so these switches save the owner's DEFAULT offer of each in its own field and
                never edit that list. */}
            <div role="group" aria-labelledby={onlineGroupId} className="flex flex-col gap-2">
              <p id={onlineGroupId} className="text-[13px] font-semibold">
                Online with ServWave Payments
              </p>
              <OnlineMethodRow
                label="Credit card"
                available={onlinePaymentsInPlan && canTakeCards}
                unavailableReason={unavailableReason}
                checked={watch('card_offered_by_default') ?? true}
                onCheckedChange={(v) => setValue('card_offered_by_default', v, { shouldDirty: true })}
              />
              <OnlineMethodRow
                label="Bank (ACH)"
                available={onlinePaymentsInPlan && canTakeBank}
                unavailableReason={unavailableReason}
                checked={watch('bank_offered_by_default') ?? true}
                onCheckedChange={(v) => setValue('bank_offered_by_default', v, { shouldDirty: true })}
              />
            </div>
            <div className="flex flex-col gap-2 border-t border-border-soft pt-4">
              <p id={handGroupId} className="text-[13px] font-semibold">
                Recorded by hand
              </p>
              <div
                role="group"
                aria-labelledby={handGroupId}
                className="grid gap-2"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}
              >
                {PAYMENT_METHOD_ORDER.filter((method) => method !== 'CARD').map((method) => {
                  const checked = methods.includes(method);
                  return (
                    <Label
                      key={method}
                      className={cn(
                        'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border px-3 font-medium',
                        checked ? 'border-brand bg-brand-subtle' : 'border-input bg-surface-light',
                      )}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(next) => {
                          const list =
                            next === true
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
            </div>
          </div>
        </Section>
      </div>

      <div id="sec-deposit">
        <Section
          title="Default deposit"
          info={
            <InfoPopover label="Default deposit">
              The deposit asked for on a new estimate, unless you change it on that estimate.
            </InfoPopover>
          }
        >
          <div className="flex flex-col gap-4">
            <PillRadios
              label="When the deposit is paid"
              options={DEPOSIT_POLICY_OPTIONS}
              value={depositPolicy}
              onChange={(v) => setValue('deposit_policy', v, { shouldDirty: true })}
            />
            <PillRadios
              label="Deposit amount"
              options={[
                ['PERCENTAGE', 'Percentage'],
                ['FIXED', 'Fixed amount'],
              ] as const}
              value={depositType}
              onChange={(v) => setValue('deposit_default_type', v, { shouldDirty: true })}
            />
            {depositType === 'PERCENTAGE' ? (
              <div className="flex max-w-50 flex-col gap-1.5">
                <Label htmlFor={DEPOSIT_PCT_ID} className="text-xs">
                  Percentage (0-100)
                </Label>
                <Adorned side="right" unit="%">
                  <Input
                    id={DEPOSIT_PCT_ID}
                    kind="percent"
                    step="0.5"
                    value={numberValue(depositPct)}
                    onValueChange={(n) => {
                      setValue('deposit_default_percentage', n ?? Number.NaN, { shouldDirty: true });
                      clearFieldError(DEPOSIT_PCT_ID);
                    }}
                    className={cn('h-11 rounded-r-none', DEPOSIT_PCT_ID in fieldErrors && 'border-danger')}
                    aria-invalid={DEPOSIT_PCT_ID in fieldErrors}
                    aria-describedby={DEPOSIT_PCT_ID in fieldErrors ? `${DEPOSIT_PCT_ID}-error` : undefined}
                  />
                </Adorned>
                <FieldMessage id={`${DEPOSIT_PCT_ID}-error`} message={fieldErrors[DEPOSIT_PCT_ID]} />
              </div>
            ) : (
              <div className="flex max-w-50 flex-col gap-1.5">
                <Label htmlFor={DEPOSIT_FIXED_ID} className="text-xs">
                  Fixed amount
                </Label>
                <Adorned side="left" unit="$">
                  <Input
                    id={DEPOSIT_FIXED_ID}
                    kind="money"
                    step="0.01"
                    value={numberValue(depositFixed)}
                    onValueChange={(n) => {
                      setValue('deposit_default_fixed_amount', n ?? Number.NaN, { shouldDirty: true });
                      clearFieldError(DEPOSIT_FIXED_ID);
                    }}
                    className={cn('h-11 rounded-l-none', DEPOSIT_FIXED_ID in fieldErrors && 'border-danger')}
                    aria-invalid={DEPOSIT_FIXED_ID in fieldErrors}
                    aria-describedby={DEPOSIT_FIXED_ID in fieldErrors ? `${DEPOSIT_FIXED_ID}-error` : undefined}
                  />
                </Adorned>
                <FieldMessage id={`${DEPOSIT_FIXED_ID}-error`} message={fieldErrors[DEPOSIT_FIXED_ID]} />
              </div>
            )}
          </div>
        </Section>
      </div>

      <div id="sec-tips">
        <Section
          title="Tips"
          info={
            <InfoPopover label="Tips">
              A gratuity customers can add when they pay an invoice. They can also enter their own amount or skip the tip.
            </InfoPopover>
          }
        >
          <div className="flex flex-col gap-4">
            <div className="flex min-h-11 items-center justify-between gap-4">
              <span id="tips-switch-label" className="text-sm font-medium">
                Let customers add a tip
              </span>
              <Switch
                aria-labelledby="tips-switch-label"
                checked={tipsEnabled}
                onCheckedChange={(v) => setValue('tips_enabled', v, { shouldDirty: true })}
              />
            </div>
            {tipsEnabled && (
              <div data-testid="tip-presets-row" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[0, 1, 2].map((i) => {
                  const id = tipFieldId(i);
                  const bad = id in fieldErrors;
                  return (
                    <div key={id} className="flex flex-col gap-1.5">
                      <Label htmlFor={id} className="text-xs">{`Choice ${i + 1}`}</Label>
                      <Adorned side="right" unit="%">
                        <Input
                          id={id}
                          kind="count"
                          value={numberValue(tipPresets[i] ?? Number.NaN)}
                          onValueChange={(n) => {
                            const next = [...tipPresets];
                            next[i] = n ?? Number.NaN;
                            setValue('tip_presets', next, { shouldDirty: true });
                            // A duplicate depends on the other boxes, so any edit retires all the tip messages.
                            setFieldErrors((cur) =>
                              Object.fromEntries(Object.entries(cur).filter(([k]) => !k.startsWith('tip-choice-'))),
                            );
                          }}
                          className={cn('h-11 rounded-r-none', bad && 'border-danger')}
                          aria-invalid={bad}
                          aria-describedby={bad ? `${id}-error` : undefined}
                        />
                      </Adorned>
                      <FieldMessage id={`${id}-error`} message={fieldErrors[id]} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Section>
      </div>

      {isAdmin && (
        <div id="sec-bank">
          <Section
            title="Bank-transfer instructions"
            info={
              <InfoPopover label="Bank-transfer instructions">
                Shown to customers who choose to pay by bank transfer. Transfers are not tracked automatically: when one arrives, record the payment on the invoice yourself.
              </InfoPopover>
            }
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={BANK_ID} className="text-xs">
                Instructions customers see
              </Label>
              <Textarea
                id={BANK_ID}
                rows={5}
                placeholder="Account name, routing and account numbers, and the reference to use"
                aria-invalid={bankBad}
                aria-describedby={BANK_ID in fieldErrors ? `${BANK_ID}-error` : undefined}
                className={cn('mobile:!text-base', bankBad && 'border-danger')}
                {...bankRegister}
                onChange={(e) => {
                  void bankRegister.onChange(e);
                  clearFieldError(BANK_ID);
                }}
              />
              <span
                data-testid="bank-instructions-counter"
                className={cn('self-end text-xs text-text-secondary', bankText.length > BANK_MAX && 'font-semibold text-danger')}
              >
                {bankText.length.toLocaleString('en-US')} of 5,000
              </span>
              <FieldMessage id={`${BANK_ID}-error`} message={fieldErrors[BANK_ID]} />
            </div>
          </Section>
        </div>
      )}

      <div id="sec-related">
        <Section
          title="Payment terms"
          info={
            <InfoPopover label="Payment terms">
              The wording about when payment is due, printed on estimates and invoices.
            </InfoPopover>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-sm">Estimate and invoice payment terms</b>
              <Badge variant="softNeutral">Edited elsewhere</Badge>
            </div>
            <NewTabLink variant="button" href="/settings/branding" className="max-sm:min-h-11">
              Open Branding & Templates
            </NewTabLink>
          </div>
        </Section>
      </div>
    </>
  );

  return { summary, cards };
}
