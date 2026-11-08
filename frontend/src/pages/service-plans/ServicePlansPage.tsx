import { useScheduleTimezone, pickerValueToIso } from '@/lib/schedule-tz';
import { useEffect, useMemo, useState } from 'react';
import api from '@/lib/axios';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  useServicePlans, useServicePlan, useCreateServicePlan, useUpdateServicePlan, useActivateServicePlan,
  useRenewServicePlan, useCancelServicePlan, useDeleteServicePlan, useScheduleVisit,
  type ServicePlan, planLineItemsTotal, describeRecurrence,
} from '@/lib/api/service-plans';
import {
  RecurrenceBuilder, recurrenceToPayload, DEFAULT_RECURRENCE, type RecurrenceValue,
} from '@/components/service-plans/RecurrenceBuilder';
import { useUsers } from '@/lib/api/users';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/data/status-badge';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/form/DatePicker';
import { DateTimePicker } from '@/components/form/DateTimePicker';
import { FormField } from '@/components/patterns/FormField';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/patterns/TabStrip';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/data/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { CustomerPickerWithCreate } from '@/components/crm/CustomerPickerWithCreate';
import {
  PickOrAccreteLocation, ADD_NEW_LOCATION,
  type PickOrAccreteLocationValue, type ServiceLocationOption,
} from '@/components/crm/PickOrAccreteLocation';
import { TrackedItemSearch } from '@/components/inventory/lo/TrackedItemSearch';
import { resolveServiceLocationId } from '@/lib/service-plans/resolveServiceLocationId';
import { useToast } from '@/components/ui/use-toast';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { formatExactDay } from '@/lib/format-date';

// ─── helpers ─────────────────────────────────────────────────────────────────

// Delegates to the canonical formatter, which reads the org's configured
// currency. The hardcoded `$` this replaces was the same defect already fixed
// once in phone's fmtMoney - user-facing for any non-USD org.
const money = formatCurrency;
const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('en-US') : '—');
// Same rendering as `date` above, for a value that is a calendar day and not an instant, so it is read in UTC.
const day = (s: string | null | undefined) =>
  (s ? formatExactDay(s, { month: 'numeric', day: 'numeric', year: 'numeric' }) : '—');
const customerName = (p: ServicePlan) =>
  p.customer ? (p.customer.company_name || [p.customer.first_name, p.customer.last_name].filter(Boolean).join(' ') || 'Customer') : '—';
const property = (p: ServicePlan) => (p.service_location ? [p.service_location.city, p.service_location.state].filter(Boolean).join(', ') : '—');

// ─── Overview ──────────────────────────────────────────────────────────────

function OverviewTab({ plans }: { plans: ServicePlan[] }) {
  const k = useMemo(() => {
    let active = 0, drafts = 0, revenue = 0, remaining = 0;
    for (const p of plans) {
      if (p.effective_status === 'ACTIVE') { active++; revenue += Number(p.contract_price); }
      if (p.status === 'DRAFT') drafts++;
      remaining += p.visits_remaining ?? 0;
    }
    return { active, drafts, revenue, remaining, total: plans.length };
  }, [plans]);
  const tiles = [
    { label: 'Total plans', value: k.total },
    { label: 'Active', value: k.active },
    { label: 'Drafts', value: k.drafts },
    { label: 'Contract revenue (active)', value: money(k.revenue) },
    { label: 'Visits remaining', value: k.remaining },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {tiles.map((t) => (
        <Card padding="sm" key={t.label}>
          <div className="text-xs text-text-secondary">{t.label}</div>
          <div className="text-2xl font-semibold text-text-primary mt-1">{t.value}</div>
        </Card>
      ))}
    </div>
  );
}

// ─── Plans table ───────────────────────────────────────────────────────────

function PlansTab({ plans, onOpen }: { plans: ServicePlan[]; onOpen: (id: string) => void }) {
  if (plans.length === 0) return <Card padding="lg" className="text-center text-text-secondary">No service plans yet.</Card>;
  return (
    <Card padding="none" className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Plan</TableHead><TableHead>Customer</TableHead><TableHead>Property</TableHead>
            <TableHead>Cadence</TableHead><TableHead>Next due</TableHead><TableHead>Remaining</TableHead><TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((p) => (
            <TableRow key={p.id} className="cursor-pointer" onClick={() => onOpen(p.id)}>
              <TableCell weight="medium">{p.service_plan_number}</TableCell>
              <TableCell>{customerName(p)}</TableCell>
              <TableCell>{property(p)}</TableCell>
              <TableCell>{describeRecurrence(p)}</TableCell>
              <TableCell tone={p.emphasized ? 'highlight' : 'default'}>{day(p.next_due)}</TableCell>
              <TableCell>{p.visits_remaining ?? 'Ongoing'}</TableCell>
              <TableCell><StatusBadge domain="servicePlan" status={p.effective_status} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

// ─── History (completed visits) ──────────────────────────────────────────────

function HistoryTab({ plans }: { plans: ServicePlan[] }) {
  const rows = useMemo(
    () =>
      plans.flatMap((p) =>
        (p.visits ?? [])
          .filter((v) => v.status === 'COMPLETED')
          // `when` is rendered here, not at the cell: the fallback crosses kinds, so a
          // completed_at is an instant (local) and a scheduled_date is a calendar day (UTC).
          .map((v) => ({ id: `${p.id}-${v.scheduled_date}`, plan: p.service_plan_number, customer: customerName(p), when: v.completed_at ? date(v.completed_at) : day(v.scheduled_date) })),
      ),
    [plans],
  );
  if (rows.length === 0) return <Card padding="lg" className="text-center text-text-secondary">No completed visits yet.</Card>;
  return (
    <Card padding="none" className="overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow><TableHead>Plan</TableHead><TableHead>Customer</TableHead><TableHead>Completed</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}><TableCell weight="medium">{r.plan}</TableCell><TableCell>{r.customer}</TableCell><TableCell>{r.when}</TableCell></TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

// ─── Builder dialog ──────────────────────────────────────────────────────────

export function PlanBuilderDialog({ open, onOpenChange, presetCustomerId, presetCustomerLabel }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  // When launched from a specific customer (e.g. the customer profile), the customer is fixed:
  // the searchable picker is replaced with a read-only label and reset() restores this customer.
  presetCustomerId?: string;
  presetCustomerLabel?: string;
}) {
  const create = useCreateServicePlan();
  const { data: users } = useUsers();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [customerId, setCustomerId] = useState(presetCustomerId ?? '');
  // Plan start dates and visit times mean the ORG's clock, never the viewer's browser.
  const timezone = useScheduleTimezone();
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
  const [materials, setMaterials] = useState<
    { item_id: string; item_sku: string | null; item_name: string; qty: number }[]
  >([]);

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
  // jsdom effect-loop that hangs vitest — do NOT drop `!locValue.locationId`)
  useEffect(() => {
    const l = locations[0];
    if (locations.length === 1 && l && !locValue.locationId) {
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

  // The recurrence builder owns the term (Ends: never / on date / after N) — see RecurrenceBuilder.
  // If "Ends → on a date" is chosen, the date is required (otherwise it would silently be open-ended).
  const canSubmit =
    !!customerId && locationChosen && name && startDate && total > 0 && items.every((i) => i.name) &&
    materials.every((m) => m.qty > 0) &&
    (recurrence.end_mode !== 'on' || !!recurrence.end_date) && !submitting;

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
        start_date: pickerValueToIso(startDate, timezone)!,
        // Structured recurrence (interval/weekdays/terminators). The server fills a best-fit
        // visit_cadence — we don't send one.
        ...recurrenceToPayload(recurrence),
        contract_price: total,
        line_items: items,
        material_lines: materials.map((m) => ({ item_id: m.item_id, qty: m.qty })),
        sold_by: soldBy || null,
      });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast({ title: 'Could not create plan', description: extractApiError(err, 'Please try again.'), variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>New service plan</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-4">
            {/* Customer - not converted to FormField: CustomerPickerWithCreate has no id
                prop of its own to receive fieldProps, and the presetCustomerId branch
                renders a plain read-only display div, not a control at all. */}
            <div>
              <label className="text-sm text-text-secondary">Customer</label>
              {presetCustomerId ? (
                <div className="mt-1 rounded-control border border-border bg-background-light px-3 py-2 text-sm text-text-primary">
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
            {/* Service location - not converted to FormField: PickOrAccreteLocation
                already renders its own label through FormField internally (`label` prop,
                defaulted to "Location") and has no id prop of its own for an outer
                FormField to target - the pre-existing double label here is unrelated to
                this batch and out of scope to fix. */}
            <div>
              <label className="text-sm text-text-secondary">Service location</label>
              {customerId ? (
                <PickOrAccreteLocation locations={locations} value={locValue} onChange={setLocValue} required showPicker />
              ) : (
                <p className="mt-2 text-sm text-text-secondary">Select a customer first.</p>
              )}
            </div>
          </div>

          <FormField label="Plan name" htmlFor="plan-name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Annual HVAC Maintenance" />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Start date" htmlFor="plan-start-date">
              <DatePicker value={startDate} onChange={setStartDate} />
            </FormField>
            {/* Render prop, not a cloned child: `Select` is Radix's context root and
                renders no DOM of its own, so the generated id has to land on the
                trigger (a labelable <button>) for the label to point at anything. */}
            <FormField label="Sold by">
              {(fieldProps) => (
                <Select value={soldBy} onValueChange={setSoldBy}>
                  <SelectTrigger {...fieldProps}><SelectValue placeholder="(optional)" /></SelectTrigger>
                  <SelectContent>
                    {(users ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.first_name} {u.last_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>

          {/* Recurrence - not converted to FormField: RecurrenceBuilder is a compound
              picker (interval/weekdays/terminators) with no id prop of its own to
              receive fieldProps. */}
          <div>
            <label className="text-sm font-medium text-text-primary">Recurrence</label>
            <div className="mt-1">
              <RecurrenceBuilder value={recurrence} onChange={setRecurrence} />
            </div>
          </div>

          {/* Line items - not converted to FormField: this label heads a repeating
              add/remove list of per-row inputs, not a single control with one id. */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-text-primary">Line items</label>
              <Button size="sm" variant="outline" onClick={() => setItems([...items, { name: '', quantity: 1, unit_price: 0 }])}>Add item</Button>
            </div>
            <div className="space-y-2">
              {items.map((it, i) => (
                <div key={i} className="grid grid-cols-[1fr_80px_120px_40px] gap-2 items-center">
                  <Input placeholder="Description" value={it.name} onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                  <Input type="number" min={1} value={it.quantity} onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, quantity: Number(e.target.value) } : x))} />
                  <Input type="number" min={0} step="0.01" value={it.unit_price} onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, unit_price: Number(e.target.value) } : x))} />
                  <Button size="sm" variant="ghost" disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</Button>
                </div>
              ))}
            </div>
            <div className="text-right mt-2 text-sm font-medium">Contract price: {money(total)}</div>
          </div>

          {/* Default materials - not converted to FormField: this label heads a
              repeating add/remove materials list plus a hint paragraph, not a single
              control with one id. */}
          <div>
            <label className="text-sm font-medium text-text-primary">Default materials</label>
            <p className="text-xs text-text-secondary mb-2">
              Tracked parts auto-added to each visit’s logistic order. Optional.
            </p>
            {materials.length > 0 && (
              <div className="space-y-2 mb-2">
                {materials.map((m, i) => (
                  <div key={i} className="grid grid-cols-[1fr_80px_40px] gap-2 items-center">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-text-primary">{m.item_name}</p>
                      {m.item_sku && <code className="font-mono text-xs text-text-secondary">{m.item_sku}</code>}
                    </div>
                    <Input
                      type="number" min={0.01} step={0.01}
                      aria-label={`Quantity for ${m.item_name}`}
                      value={m.qty}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        setMaterials(materials.map((x, j) => j === i ? { ...x, qty: Number.isFinite(n) ? n : 0 } : x));
                      }}
                      className="text-right"
                    />
                    <Button
                      size="sm" variant="ghost"
                      aria-label={`Remove ${m.item_name}`}
                      onClick={() => setMaterials(materials.filter((_, j) => j !== i))}
                    >✕</Button>
                  </div>
                ))}
              </div>
            )}
            <TrackedItemSearch
              onPick={(item) =>
                setMaterials((prev) =>
                  prev.some((m) => m.item_id === item.id)
                    ? prev
                    : [...prev, { item_id: item.id, item_sku: item.sku ?? null, item_name: item.name, qty: 1 }],
                )
              }
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="solid" tone="business" disabled={!canSubmit} onClick={submit}>
            {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Detail sheet ────────────────────────────────────────────────────────────

export function PlanDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: plan } = useServicePlan(id ?? undefined);
  const activate = useActivateServicePlan();
  const renew = useRenewServicePlan();
  const cancel = useCancelServicePlan();
  const del = useDeleteServicePlan();
  const schedule = useScheduleVisit();
  const updatePlan = useUpdateServicePlan();
  const { data: users } = useUsers();
  const { toast } = useToast();

  // Plan start dates and visit times mean the ORG's clock, never the viewer's browser.
  const timezone = useScheduleTimezone();
  const [visitDate, setVisitDate] = useState('');
  const [tech, setTech] = useState('');

  // Default materials — editable regardless of plan status (a Logistic Order never touches
  // invoice pricing, so revising the template can't desync anything already billed; the edit
  // affects future scheduled visits only, never an already-minted LO — see the backend edit-lock
  // comment in service-plan.controller.ts). Dead catalog refs (item_id: null) drop out of the
  // draft on entering edit mode — there is no valid item_id left to resend.
  const [editingMaterials, setEditingMaterials] = useState(false);
  const [materialsDraft, setMaterialsDraft] = useState<
    { item_id: string; item_sku: string | null; item_name: string; qty: number }[]
  >([]);

  const startEditingMaterials = () => {
    setMaterialsDraft(
      (plan?.material_lines ?? [])
        .filter((m): m is typeof m & { item_id: string } => m.item_id !== null)
        .map((m) => ({ item_id: m.item_id, item_sku: null, item_name: m.item_name, qty: Number(m.qty) })),
    );
    setEditingMaterials(true);
  };

  const saveMaterials = async () => {
    if (!plan) return;
    try {
      await updatePlan.mutateAsync({
        id: plan.id,
        material_lines: materialsDraft.map((m) => ({ item_id: m.item_id, qty: m.qty })),
      });
      setEditingMaterials(false);
    } catch (err) {
      toast({ title: 'Could not save materials', description: extractApiError(err, 'Please try again.'), variant: 'destructive' });
    }
  };

  const open = !!id;
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        {plan && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {plan.service_plan_number}
                <StatusBadge domain="servicePlan" status={plan.effective_status} />
              </SheetTitle>
            </SheetHeader>
            <div className="mt-4 space-y-4 text-sm">
              <div className="font-medium text-text-primary text-base">{plan.name}</div>
              <div className="grid grid-cols-2 gap-y-2">
                <div className="text-text-secondary">Customer</div><div>{customerName(plan)}</div>
                <div className="text-text-secondary">Property</div><div>{property(plan)}</div>
                <div className="text-text-secondary">Recurrence</div><div>{describeRecurrence(plan)}</div>
                <div className="text-text-secondary">Term</div><div>{day(plan.start_date)} – {plan.end_date ? day(plan.end_date) : 'Ongoing'}</div>
                <div className="text-text-secondary">Next due</div><div className={plan.emphasized ? 'text-danger-text font-medium' : ''}>{day(plan.next_due)}</div>
                <div className="text-text-secondary">Visits remaining</div><div>{plan.visits_remaining === null ? 'Ongoing (no end date)' : `${plan.visits_remaining} of ${plan.planned_visit_count}`}</div>
                <div className="text-text-secondary">Contract price</div><div>{money(plan.contract_price)}</div>
                <div className="text-text-secondary">Renewals</div><div>{plan.renewals_count}</div>
              </div>

              <div>
                <div className="font-medium mb-1">Line items</div>
                {plan.line_items.map((li, i) => (
                  <div key={i} className="flex justify-between text-text-secondary"><span>{li.name} × {li.quantity}</span><span>{money(Number(li.unit_price) * li.quantity)}</span></div>
                ))}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="font-medium">Default materials</div>
                  {!editingMaterials && (
                    <Button size="sm" variant="outline" onClick={startEditingMaterials}>Edit</Button>
                  )}
                </div>

                {!editingMaterials && (
                  (plan.material_lines && plan.material_lines.length > 0) ? (
                    plan.material_lines.map((m, i) => (
                      <div key={i} className="flex justify-between text-text-secondary">
                        <span>
                          {m.item_name}
                          {m.item_id === null && <span className="ml-1 text-xs text-warning">(removed from catalog)</span>}
                        </span>
                        <span>× {Number(m.qty)}</span>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs text-text-secondary">No default materials — tracked parts auto-added to each visit’s logistic order.</p>
                  )
                )}

                {editingMaterials && (
                  <div className="space-y-2">
                    {materialsDraft.map((m, i) => (
                      <div key={i} className="grid grid-cols-[1fr_80px_40px] gap-2 items-center">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-text-primary">{m.item_name}</p>
                          {m.item_sku && <code className="font-mono text-xs text-text-secondary">{m.item_sku}</code>}
                        </div>
                        <Input
                          type="number" min={0.01} step={0.01}
                          aria-label={`Quantity for ${m.item_name}`}
                          value={m.qty}
                          onChange={(e) => {
                            const n = parseFloat(e.target.value);
                            setMaterialsDraft(materialsDraft.map((x, j) => j === i ? { ...x, qty: Number.isFinite(n) ? n : 0 } : x));
                          }}
                          className="text-right"
                        />
                        <Button
                          size="sm" variant="ghost"
                          aria-label={`Remove ${m.item_name}`}
                          onClick={() => setMaterialsDraft(materialsDraft.filter((_, j) => j !== i))}
                        >✕</Button>
                      </div>
                    ))}
                    <TrackedItemSearch
                      onPick={(item) =>
                        setMaterialsDraft((prev) =>
                          prev.some((m) => m.item_id === item.id)
                            ? prev
                            : [...prev, { item_id: item.id, item_sku: item.sku ?? null, item_name: item.name, qty: 1 }],
                        )
                      }
                    />
                    <div className="flex justify-end gap-2 pt-1">
                      <Button size="sm" variant="outline" onClick={() => setEditingMaterials(false)}>Cancel</Button>
                      <Button
                        size="sm" variant="solid" tone="business"
                        disabled={updatePlan.isPending || materialsDraft.some((m) => m.qty <= 0)}
                        onClick={saveMaterials}
                      >
                        {updatePlan.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Save materials
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              {plan.invoices && plan.invoices.length > 0 && (
                <div>
                  <div className="font-medium mb-1">Invoices</div>
                  {plan.invoices.map((inv) => (
                    <div key={inv.id} className="flex justify-between text-text-secondary"><span>{inv.invoice_number} ({inv.kind})</span><span>{money(inv.total_amount)}</span></div>
                  ))}
                </div>
              )}

              {/* Lifecycle actions */}
              <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                {plan.status === 'DRAFT' && (
                  <>
                    <Button variant="solid" tone="business" size="sm" disabled={activate.isPending} onClick={() => activate.mutate(plan.id)}>Activate</Button>
                    <Button variant="outline" size="sm" disabled={del.isPending} onClick={() => del.mutate(plan.id, { onSuccess: onClose })}>Delete</Button>
                  </>
                )}
                {plan.status === 'ACTIVE' && (
                  <>
                    {/* Renew rolls the term forward — only meaningful for a fixed-term plan, not an open-ended one. */}
                    {plan.end_date && (
                      <Button variant="solid" tone="business" size="sm" disabled={renew.isPending} onClick={() => renew.mutate(plan.id)}>Renew</Button>
                    )}
                    <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate(plan.id)}>Cancel plan</Button>
                  </>
                )}
              </div>

              {plan.status === 'ACTIVE' && (plan.visits_remaining === null || plan.visits_remaining > 0) && (
                <div className="pt-2 border-t border-border space-y-2">
                  <div className="font-medium">Schedule next visit</div>
                  <DateTimePicker value={visitDate} onChange={setVisitDate} />
                  <Select value={tech} onValueChange={setTech}>
                    <SelectTrigger><SelectValue placeholder="Assign technician (optional)" /></SelectTrigger>
                    <SelectContent>{(users ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.first_name} {u.last_name}</SelectItem>)}</SelectContent>
                  </Select>
                  <Button
                    size="sm" disabled={!visitDate || schedule.isPending}
                    onClick={() => schedule.mutate({ id: plan.id, scheduled_start: pickerValueToIso(visitDate, timezone)!, assigned_to: tech || null }, { onSuccess: () => setVisitDate('') })}
                  >
                    Schedule visit
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────

export default function ServicePlansPage() {
  const { data: plans = [], isLoading } = useServicePlans();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Was `<Tabs defaultValue="plans">` (uncontrolled) - TabStrip is controlled-only, so this
  // pins the same initial tab ("plans") as explicit state instead of an uncontrolled default.
  const [activeTab, setActiveTab] = useState('plans');

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Service Plans</h1>
        <Button variant="solid" tone="business" onClick={() => setBuilderOpen(true)}>New Plan</Button>
      </div>

      <TabStrip
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'plans', label: 'Plans' },
          { value: 'history', label: 'History' },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      >
        <TabsContent value="overview" className="mt-4"><OverviewTab plans={plans} /></TabsContent>
        <TabsContent value="plans" className="mt-4">
          {isLoading ? <div className="text-text-secondary">Loading…</div> : <PlansTab plans={plans} onOpen={setDetailId} />}
        </TabsContent>
        <TabsContent value="history" className="mt-4"><HistoryTab plans={plans} /></TabsContent>
      </TabStrip>

      <PlanBuilderDialog open={builderOpen} onOpenChange={setBuilderOpen} />
      <PlanDetailSheet id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}
