import { useState } from 'react';

import {
  useServicePlan, useUpdateServicePlan, useActivateServicePlan, useRenewServicePlan,
  useCancelServicePlan, useDeleteServicePlan, useScheduleVisit, describeRecurrence,
} from '@/lib/api/service-plans';
import { useUsers } from '@/lib/api/users';
import { extractApiError } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import {
  Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle,
} from '@/ui-kit/components/ui/sheet';
import { toast } from '@/ui-kit/components/ui/sonner';

import { StatusChip } from '../../_shared/statusChip';
import { DateTimePicker } from '../../_shared/dateTimePicker';
import { ELLIPSIS, EN_DASH } from '../../_shared/glyphs';
import { MaterialLines } from '../../_shared/materialLines';
import { customerName, date, money, property, type MaterialDraftLine } from '../../_shared/planShared';

/**
 * /v2 service-plan detail, as an edge-anchored sheet.
 *
 * Everything about WHAT this renders is the legacy sheet's, including the two
 * asymmetries that look like bugs and are not:
 *
 *  - the lifecycle action row branches on the RAW `plan.status`, while the
 *    header badge shows the server-derived `effective_status`;
 *  - `Renew` is hidden (not disabled) for an open-ended ACTIVE plan, because
 *    rolling a term forward means nothing without a term.
 *
 * Default materials stay editable at every status. That is deliberate and the
 * server agrees: a non-DRAFT PATCH is rejected unless its keys fall inside
 * {name, sold_by, material_lines}, and this is the only PATCH the module sends.
 *
 * Activate / Renew / Cancel / Delete / Schedule visit still pass no `onError`,
 * so a rejection is silent. That is today's behaviour, reproduced as-is and
 * logged in the gap ledger rather than fixed inside a restyle.
 */
function PlanDetailSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: plan } = useServicePlan(id ?? undefined);
  const activate = useActivateServicePlan();
  const renew = useRenewServicePlan();
  const cancel = useCancelServicePlan();
  const del = useDeleteServicePlan();
  const schedule = useScheduleVisit();
  const updatePlan = useUpdateServicePlan();
  const { data: users } = useUsers();

  const [visitDate, setVisitDate] = useState('');
  const [tech, setTech] = useState('');

  // Dead catalog refs (item_id: null) drop out of the draft on entering edit
  // mode - there is no valid item_id left to resend.
  const [editingMaterials, setEditingMaterials] = useState(false);
  const [materialsDraft, setMaterialsDraft] = useState<MaterialDraftLine[]>([]);

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
      toast.error('Could not save materials', { description: extractApiError(err, 'Please try again.') });
    }
  };

  const open = !!id;
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent>
        {plan && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {plan.service_plan_number}
                <StatusChip domain="servicePlan" status={plan.effective_status} />
              </SheetTitle>
            </SheetHeader>
            <SheetBody>
              <div className="flex flex-col gap-4 text-sm">
                <p className="text-base font-semibold">{plan.name}</p>

                <div className="grid grid-cols-2 gap-y-2">
                  <span className="text-muted-foreground">Customer</span><span>{customerName(plan)}</span>
                  <span className="text-muted-foreground">Property</span><span>{property(plan)}</span>
                  <span className="text-muted-foreground">Recurrence</span><span>{describeRecurrence(plan)}</span>
                  <span className="text-muted-foreground">Term</span>
                  <span>{date(plan.start_date)} {EN_DASH} {plan.end_date ? date(plan.end_date) : 'Ongoing'}</span>
                  <span className="text-muted-foreground">Next due</span>
                  <span className={plan.emphasized ? 'text-destructive font-medium' : undefined}>{date(plan.next_due)}</span>
                  <span className="text-muted-foreground">Visits remaining</span>
                  <span>
                    {plan.visits_remaining === null
                      ? 'Ongoing (no end date)'
                      : `${plan.visits_remaining} of ${plan.planned_visit_count}`}
                  </span>
                  <span className="text-muted-foreground">Contract price</span><span>{money(plan.contract_price)}</span>
                  <span className="text-muted-foreground">Renewals</span><span>{plan.renewals_count}</span>
                </div>

                <div>
                  <p className="mb-1 font-semibold">Line items</p>
                  {plan.line_items.map((li, i) => (
                    <div key={i} className="text-muted-foreground flex justify-between">
                      <span>{li.name} × {li.quantity}</span>
                      <span>{money(Number(li.unit_price) * li.quantity)}</span>
                    </div>
                  ))}
                </div>

                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <p className="font-semibold">Default materials</p>
                    {!editingMaterials && (
                      <Button size="sm" variant="outline" onClick={startEditingMaterials}>Edit</Button>
                    )}
                  </div>

                  {!editingMaterials && (
                    (plan.material_lines && plan.material_lines.length > 0) ? (
                      plan.material_lines.map((m, i) => (
                        <div key={i} className="text-muted-foreground flex justify-between">
                          <span>
                            {m.item_name}
                            {m.item_id === null && (
                              <span className="text-status-amber ml-1 text-xs">(removed from catalog)</span>
                            )}
                          </span>
                          <span>× {Number(m.qty)}</span>
                        </div>
                      ))
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        No default materials - tracked parts auto-added to each visit’s logistic order.
                      </p>
                    )
                  )}

                  {editingMaterials && (
                    <div className="flex flex-col gap-2">
                      <MaterialLines lines={materialsDraft} onChange={setMaterialsDraft} />
                      <div className="flex justify-end gap-2 pt-1">
                        <Button size="sm" variant="outline" onClick={() => setEditingMaterials(false)}>Cancel</Button>
                        <Button
                          size="sm"
                          isLoading={updatePlan.isPending}
                          disabled={updatePlan.isPending || materialsDraft.some((m) => m.qty <= 0)}
                          onClick={saveMaterials}
                        >
                          Save materials
                        </Button>
                      </div>
                    </div>
                  )}
                </div>

                {plan.invoices && plan.invoices.length > 0 && (
                  <div>
                    <p className="mb-1 font-semibold">Invoices</p>
                    {plan.invoices.map((inv) => (
                      <div key={inv.id} className="text-muted-foreground flex justify-between">
                        <span>{inv.invoice_number} ({inv.kind})</span>
                        <span>{money(inv.total_amount)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Lifecycle actions. Branches on the raw status, not the
                    effective one - see the header comment. */}
                <div className="flex flex-wrap gap-2 border-t pt-2">
                  {plan.status === 'DRAFT' && (
                    <>
                      <Button size="sm" disabled={activate.isPending} onClick={() => activate.mutate(plan.id)}>
                        Activate
                      </Button>
                      {/* `destructive` rather than the legacy `outline`: this is
                          a one-click hard delete with no confirmation step, and
                          the kit expresses that through the variant rather than
                          a colour class at the call site. Same action, same
                          guard, same payload. */}
                      <Button
                        size="sm" variant="destructive" disabled={del.isPending}
                        onClick={() => del.mutate(plan.id, { onSuccess: onClose })}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                  {plan.status === 'ACTIVE' && (
                    <>
                      {/* Renew rolls the term forward - only meaningful for a fixed-term plan. */}
                      {plan.end_date && (
                        <Button size="sm" disabled={renew.isPending} onClick={() => renew.mutate(plan.id)}>
                          Renew
                        </Button>
                      )}
                      <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(plan.id)}>
                        Cancel plan
                      </Button>
                    </>
                  )}
                </div>

                {plan.status === 'ACTIVE' && (plan.visits_remaining === null || plan.visits_remaining > 0) && (
                  <div className="flex flex-col gap-2 border-t pt-2">
                    <p className="font-semibold">Schedule next visit</p>
                    <Label htmlFor="v2-plan-visit-date" className="sr-only">Visit date and time</Label>
                    {/* Was a native `datetime-local` Input. The browser draws
                        that one itself: a row of segmented spinners flush to
                        the left, then its own calendar glyph pinned outside the
                        field's right padding, so it was the only control in
                        this stack whose interior was not symmetrical and the
                        only one that did not read as the kit's. The shared
                        picker is a kit Button with the kit's own Calendar and
                        time Select inside a Popover - same string contract,
                        same field metrics as the technician Select directly
                        below it. */}
                    <DateTimePicker
                      id="v2-plan-visit-date"
                      value={visitDate}
                      onChange={setVisitDate}
                      placeholder={`Pick a date and time${ELLIPSIS}`}
                    />
                    {/* One entry point, and it counts the list itself
                        (DESIGN_SYSTEM.md §4.2): an org with ten or more
                        technicians gets a searchable picker here, a smaller one
                        keeps the plain select, and neither is declared. */}
                    <SelectField
                      value={tech}
                      onValueChange={setTech}
                      placeholder="Assign technician (optional)"
                      searchPlaceholder="Search technicians…"
                      emptyMessage="No technicians found."
                      options={(users ?? []).map((u) => ({
                        value: u.id,
                        label: `${u.first_name} ${u.last_name}`,
                      }))}
                    />
                    <Button
                      size="sm"
                      disabled={!visitDate || schedule.isPending}
                      onClick={() =>
                        schedule.mutate(
                          { id: plan.id, scheduled_start: new Date(visitDate).toISOString(), assigned_to: tech || null },
                          { onSuccess: () => setVisitDate('') },
                        )
                      }
                    >
                      Schedule visit
                    </Button>
                  </div>
                )}
              </div>
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export { PlanDetailSheet };
