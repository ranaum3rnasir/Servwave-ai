import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';

import api from '@/lib/axios';
import { useCreateServicePlan, planLineItemsTotal } from '@/lib/api/service-plans';
import { useUsers } from '@/lib/api/users';
import { extractApiError } from '@/lib/utils';
import {
  recurrenceToPayload, DEFAULT_RECURRENCE, type RecurrenceValue,
} from '@/components/service-plans/RecurrenceBuilder';
import { CustomerPickerWithCreate } from '@/components/crm/CustomerPickerWithCreate';
import {
  PickOrAccreteLocation, ADD_NEW_LOCATION,
  type PickOrAccreteLocationValue, type ServiceLocationOption,
} from '@/components/crm/PickOrAccreteLocation';
// Imported, not re-implemented. `resolveServiceLocationId` POSTs a new address
// and that POST is NOT idempotent, so its "pin the returned id back into the
// value before the plan create can fail" contract is a single invariant with
// one test guarding it (`__tests__/service-plan-builder-location.test.tsx`). A
// second copy would be a second place for that invariant to drift, which is
// exactly what the no-forking rule exists to stop.
import { resolveServiceLocationId } from '@/lib/service-plans/resolveServiceLocationId';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { toast } from '@/ui-kit/components/ui/sonner';

import { DatePicker } from './datePicker';
import { MaterialLines } from './materialLines';
import { RecurrenceBuilder } from './recurrenceBuilder';
import { money, type MaterialDraftLine } from './planShared';

interface PlanBuilderDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  // When launched from a specific customer (e.g. the customer profile), the customer is fixed:
  // the searchable picker is replaced with a read-only label and reset() restores this customer.
  presetCustomerId?: string;
  presetCustomerLabel?: string;
}

/**
 * The red asterisk marking a field the submit gate requires. Everything in this
 * dialog is required except Sold by and Default materials.
 *
 * Same glyph the inventory dialogs use, on the v2 token (`text-destructive`)
 * rather than legacy's `text-danger`. `aria-hidden` because a lone asterisk
 * reads as punctuation rather than as "required": the requirement reaches a
 * screen reader through the aria-live "Still needed" line in the footer, which
 * names the unmet fields instead of leaving the user to infer them.
 */
function RequiredMark() {
  return <span className="text-destructive ml-0.5" aria-hidden="true">*</span>;
}

/**
 * /v2 new-service-plan builder.
 *
 * Lives in `_shared/` rather than in the service-plans module because two
 * modules render it: the Service Plans page's "New plan" action, and the
 * Customer detail page with `presetCustomerId` set. A cross-module import is
 * what `__tests__/moduleIsolation.test.ts` forbids, so the component moves
 * instead of being reached for. It is domain-named, which the folder's README
 * otherwise discourages - the alternative was a second copy of a builder that
 * POSTs a non-idempotent location, which is worse.
 *
 * There is no zod schema and no react-hook-form here, and that is deliberate,
 * not an omission: the legacy builder is ten `useState` hooks and one
 * `canSubmit` boolean, the server's `createPlanSchema` is `.strict()`, and the
 * kit's own `FormField` is a react-hook-form Controller that cannot be driven
 * without a form context. So the fields are Label + control with an explicit
 * id, and the gate below is the legacy expression unchanged.
 *
 * `visit_cadence` is still not sent - the server derives a best-fit one - and
 * no key is added to the payload, because a `.strict()` schema turns any extra
 * key into a 400.
 */
function PlanBuilderDialog({
  open, onOpenChange, presetCustomerId, presetCustomerLabel,
}: PlanBuilderDialogProps) {
  const create = useCreateServicePlan();
  const { data: users } = useUsers();
  const qc = useQueryClient();

  const [customerId, setCustomerId] = useState(presetCustomerId ?? '');
  const [customerLabel, setCustomerLabel] = useState(presetCustomerLabel ?? '');
  const emptyLoc = (): PickOrAccreteLocationValue => ({
    locationId: '', address: { address_line1: '', address_line2: '', city: '', state: '', zip: '' },
  });
  const [locValue, setLocValue] = useState<PickOrAccreteLocationValue>(emptyLoc());
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(DEFAULT_RECURRENCE);
  const [soldBy, setSoldBy] = useState('');
  const [items, setItems] = useState<{ name: string; quantity: number; unit_price: number }[]>([
    { name: '', quantity: 1, unit_price: 0 },
  ]);
  // LO-5 default-materials template. Starts EMPTY (a plan with no materials is the norm). The
  // client only ever sends { item_id, qty }; sku/name here are display snapshots the server
  // re-derives at save. No location: a template has no source location (the per-visit LO picks it).
  const [materials, setMaterials] = useState<MaterialDraftLine[]>([]);

  const { data: customer } = useQuery<{ service_locations?: ServiceLocationOption[] }>({
    queryKey: ['customer', customerId, 'plan-locations'],
    queryFn: () => api.get(`/api/customers/${customerId}`).then((r) => r.data.customer ?? r.data),
    enabled: open && !!customerId,
  });
  const locations: ServiceLocationOption[] = customer?.service_locations ?? [];
  const total = planLineItemsTotal(items);

  const reset = () => {
    setCustomerId(presetCustomerId ?? ''); setCustomerLabel(presetCustomerLabel ?? ''); setLocValue(emptyLoc());
    setName(''); setRecurrence(DEFAULT_RECURRENCE);
    setStartDate(''); setSoldBy(''); setItems([{ name: '', quantity: 1, unit_price: 0 }]);
    setMaterials([]);
  };

  // auto-select when the chosen customer has exactly one location (guard prevents the
  // jsdom effect-loop that hangs vitest - do NOT drop `!locValue.locationId`)
  useEffect(() => {
    const l = locations[0];
    if (locations.length === 1 && l && !locValue.locationId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate auto-select on fetched data, already guarded to run at most once
      setLocValue({
        locationId: l.id,
        address: { address_line1: l.address_line1, address_line2: l.address_line2 || '', city: l.city, state: l.state, zip: l.zip },
      });
    }
  }, [locations, locValue.locationId]);

  const locationChosen =
    (!!locValue.locationId && locValue.locationId !== ADD_NEW_LOCATION) ||
    (locValue.locationId === ADD_NEW_LOCATION &&
      locValue.address.address_line1.trim() !== '' && locValue.address.city.trim() !== '' &&
      locValue.address.state.trim().length === 2 && locValue.address.zip.trim().length >= 5);

  // What the form is still waiting for, named rather than reduced to a boolean.
  //
  // Same conditions the submit gate always had. They are listed because a bare
  // disabled button is unreadable: eight separate requirements collapsed into
  // one greyed-out control, so a form that LOOKS complete gives no clue which
  // one is unmet. Two of them are effectively invisible - a material whose
  // quantity was cleared to retype it coerces to 0, and "Ends -> on a date"
  // with no date chosen - and either silently locks the dialog.
  //
  // The recurrence builder owns the term (Ends: never / on date / after N).
  const missing: string[] = [];
  if (!customerId) missing.push('a customer');
  if (!locationChosen) missing.push('a service location');
  if (!name) missing.push('a plan name');
  if (!startDate) missing.push('a start date');
  if (!items.every((i) => i.name)) missing.push('a description on every line item');
  if (!(total > 0)) missing.push('a line item priced above zero');
  if (!materials.every((m) => m.qty > 0)) missing.push('a quantity above zero on every material');
  if (recurrence.end_mode === 'on' && !recurrence.end_date) missing.push('an end date');

  const canSubmit = missing.length === 0 && !submitting;

  async function submit() {
    if (!customerId) return;
    setSubmitting(true);
    try {
      const authoredNewAddress = locValue.locationId === ADD_NEW_LOCATION;
      const serviceLocationId = await resolveServiceLocationId(customerId, locValue, locations.length === 0);
      if (authoredNewAddress) {
        // The address is now persisted. Pin the returned id into the value BEFORE the plan
        // create can fail, so a retry short-circuits at resolveServiceLocationId's
        // existing-id passthrough instead of POSTing a second identical location.
        setLocValue({ locationId: serviceLocationId, address: locValue.address });
        // Refresh the customer's locations too: `hadZeroLocations` is derived from this
        // query, and left stale it would send is_primary:true for a subsequent new address
        // and demote the one we just created.
        qc.invalidateQueries({ queryKey: ['customer', customerId, 'plan-locations'] });
      }
      await create.mutateAsync({
        customer_id: customerId,
        service_location_id: serviceLocationId,
        name,
        start_date: new Date(startDate).toISOString(),
        // Structured recurrence (interval/weekdays/terminators). The server fills a best-fit
        // visit_cadence - we don't send one.
        ...recurrenceToPayload(recurrence),
        contract_price: total,
        line_items: items,
        material_lines: materials.map((m) => ({ item_id: m.item_id, qty: m.qty })),
        sold_by: soldBy || null,
      });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error('Could not create plan', { description: extractApiError(err, 'Please try again.') });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New service plan</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            {/* Customer - no htmlFor: CustomerPickerWithCreate has no id prop of
                its own, and the presetCustomerId branch renders a read-only
                display, not a control at all. */}
            <div>
              <Label>Customer<RequiredMark /></Label>
              {presetCustomerId ? (
                <div className="bg-muted mt-1 rounded-md border px-3 py-2 text-sm">
                  {customerLabel || 'Customer'}
                </div>
              ) : (
                <CustomerPickerWithCreate
                  value={customerId}
                  valueLabel={customerLabel}
                  onChange={(id, label) => { setCustomerId(id); setCustomerLabel(label); setLocValue(emptyLoc()); }}
                />
              )}
            </div>

            {/* Service location - PickOrAccreteLocation already renders its own
                label internally, so this outer one produces the same double
                label the legacy dialog shows. Pre-existing and out of scope;
                fixing it means editing a component the Customers module owns. */}
            <div>
              <Label>Service location<RequiredMark /></Label>
              {customerId ? (
                <PickOrAccreteLocation locations={locations} value={locValue} onChange={setLocValue} required showPicker />
              ) : (
                <p className="text-muted-foreground mt-2 text-sm">Select a customer first.</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="v2-plan-name">Plan name<RequiredMark /></Label>
              <Input
                id="v2-plan-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Annual HVAC Maintenance"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="v2-plan-start-date">Start date<RequiredMark /></Label>
                <DatePicker
                  id="v2-plan-start-date"
                  value={startDate}
                  onChange={setStartDate}
                />
              </div>
              {/* The id lands on the Radix trigger, the only labelable element
                  a Select renders - the root itself renders no DOM. */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="v2-plan-sold-by">Sold by</Label>
                <SelectField
                  id="v2-plan-sold-by"
                  value={soldBy}
                  onValueChange={setSoldBy}
                  placeholder="(optional)"
                  options={(users ?? []).map((u) => ({
                    value: u.id,
                    label: `${u.first_name} ${u.last_name}`,
                  }))}
                />
              </div>
            </div>

            {/* Recurrence - a compound picker (interval/weekdays/terminators)
                with no single control to point a label at. */}
            <div>
              <Label>Recurrence<RequiredMark /></Label>
              <div className="mt-1">
                <RecurrenceBuilder value={recurrence} onChange={setRecurrence} />
              </div>
            </div>

            {/* Line items - this label heads a repeating add/remove list, not
                one control with one id. */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <Label>Line items<RequiredMark /></Label>
                <Button
                  size="sm" variant="outline"
                  onClick={() => setItems([...items, { name: '', quantity: 1, unit_price: 0 }])}
                >
                  Add item
                </Button>
              </div>
              {/* Column headers. The three inputs below carry only placeholders,
                  so before this there was no label to mark and the row read as
                  already filled: quantity shows 1 and price shows 0, both of
                  which look like answers. Price 0 is the one that blocks submit.
                  Qty is not marked - it ships at 1, which is already valid. */}
              <div className="text-text-secondary mb-1 grid grid-cols-[1fr_80px_120px_40px] gap-2 text-xs">
                <span>Description<RequiredMark /></span>
                <span>Qty</span>
                <span>Price<RequiredMark /></span>
                <span />
              </div>
              <div className="flex flex-col gap-2">
                {items.map((it, i) => (
                  <div key={i} className="grid grid-cols-[1fr_80px_120px_40px] items-center gap-2">
                    <Input
                      placeholder="Description"
                      aria-label={`Line item ${i + 1} description`}
                      value={it.name}
                      onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                    <Input
                      type="number" min={1}
                      aria-label={`Line item ${i + 1} quantity`}
                      value={it.quantity}
                      onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))}
                    />
                    {/* Blank, not 0, until a price is typed. A zero here reads as
                        a priced row and is the single most common reason the
                        dialog refuses to submit. The state stays a number - only
                        the rendered value is emptied - so the payload and
                        planLineItemsTotal are untouched. */}
                    <Input
                      type="number" min={0} step="0.01"
                      placeholder="0.00"
                      aria-label={`Line item ${i + 1} price`}
                      value={it.unit_price || ''}
                      onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, unit_price: Number(e.target.value) } : x)))}
                    />
                    <Button
                      size="icon-sm" variant="ghost"
                      aria-label={`Remove line item ${i + 1}`}
                      disabled={items.length === 1}
                      onClick={() => setItems(items.filter((_, j) => j !== i))}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-right text-sm font-medium">Contract price: {money(total)}</div>
            </div>

            {/* Default materials - same shape: a label over a repeating list
                plus a hint paragraph. */}
            <div>
              <Label>Default materials</Label>
              <p className="text-muted-foreground mb-2 text-xs">
                Tracked parts auto-added to each visit’s logistic order. Optional.
              </p>
              <MaterialLines lines={materials} onChange={setMaterials} />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          {/* Say what is missing, next to the control that is refusing to act.
              Not a toast: the answer has to stay on screen while the user goes
              back and fixes the field. `aria-live` so a screen reader hears the
              reason change rather than only meeting a disabled button. */}
          {missing.length > 0 && !submitting && (
            <p className="text-text-secondary mr-auto text-xs" aria-live="polite">
              Still needed: {missing.join(', ')}
            </p>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canSubmit} isLoading={submitting} onClick={submit}>Create draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { PlanBuilderDialog };
