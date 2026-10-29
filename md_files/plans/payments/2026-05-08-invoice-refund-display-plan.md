# Invoice Refund Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the invoice detail page show the full financial lifecycle of a job — deposit, payments, and refunds — so an admin can answer "how much, when, by whom" in under 5 seconds without opening Stripe.

**Architecture:** Three targeted changes across three files. (1) Backend select adds 6 missing fields so refund and deposit data reaches the frontend. (2) `status-badge.tsx` changes REFUNDED from purple to danger red. (3) `InvoiceDetailPage.tsx` gains new TypeScript types, a redesigned Payments tab ledger, a refunded row in the totals block, and updated tab counter.

**Tech Stack:** Node/Express/Prisma (backend select), React 18/TypeScript/Tailwind/shadcn (frontend)

**Worktree:** `C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm-worktrees\stripe-9c`

---

## File Map

| File | Change |
|------|--------|
| `backend/src/controllers/invoice.controller.ts` | Add 6 fields to `invoiceDetailSelect` (lines ~100–217) |
| `frontend/src/components/ui/status-badge.tsx` | Change REFUNDED className from purple to danger red |
| `frontend/src/pages/InvoiceDetailPage.tsx` | Types, ledger tab, totals row, tab counter |

No new files. No schema migrations. No new API endpoints.

---

## Task 1: Backend — Extend invoiceDetailSelect

**Files:**
- Modify: `backend/src/controllers/invoice.controller.ts` lines 100–217

### What to change

The `invoiceDetailSelect` object needs 6 new fields.

**On the invoice root level** (after `voided_reason: true,` at ~line 116), add:
```ts
refunded_at: true,
total_refunded: true,
refund_reason: true,
refund_reason_category: true,
```

**On the deposit select** (inside `job.estimate.deposit.select`, currently lines 169–176), add:
```ts
refunded_at: true,
surcharge_amount: true,
```

- [ ] **Step 1: Open the file and locate the two insertion points**

File: `backend/src/controllers/invoice.controller.ts`

- Insertion point A: line ~116, after `voided_reason: true,`
- Insertion point B: line ~175, after `paid_at: true,` inside the deposit select

- [ ] **Step 2: Add the 4 invoice-level fields (insertion point A)**

The root invoice select block should look like this after the edit:

```ts
  voided_at: true,
  voided_reason: true,
  refunded_at: true,
  total_refunded: true,
  refund_reason: true,
  refund_reason_category: true,
  created_at: true,
```

- [ ] **Step 3: Add the 2 deposit-level fields (insertion point B)**

The deposit select block should look like this after the edit:

```ts
          deposit: {
            select: {
              id: true,
              amount: true,
              status: true,
              total_refunded: true,
              payment_method: true,
              paid_at: true,
              refunded_at: true,
              surcharge_amount: true,
            },
          },
```

- [ ] **Step 4: Run backend tests to confirm no regressions**

```bash
cd C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm-worktrees\stripe-9c
npm test --workspace=backend
```

Expected: all tests pass (688 tests, 0 failures).

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/invoice.controller.ts
git commit -m "feat(invoices): expose refund + deposit fields in invoiceDetailSelect"
```

---

## Task 2: StatusBadge — REFUNDED → Danger Red

**Files:**
- Modify: `frontend/src/components/ui/status-badge.tsx` line 31

### Current state

```ts
REFUNDED: { label: 'Refunded', className: 'bg-purple-50 text-purple-700 border-purple-200' },
```

This is the only entry for REFUNDED and it is shared by both Deposit and Invoice REFUNDED status. It currently renders purple.

- [ ] **Step 1: Change the REFUNDED className to danger red**

```ts
REFUNDED: { label: 'Refunded', className: 'bg-red-50 text-red-700 border-red-200' },
```

Note: This affects all entities that use `<StatusBadge status="REFUNDED" />` — including deposits on the Estimate page. That is intentional: a refunded deposit badge should also read as red.

- [ ] **Step 2: Verify visually**

Start the frontend dev server if not already running:
```bash
cd C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm-worktrees\stripe-9c
npm run dev:frontend
```

Navigate to the REFUNDED invoice (I00002) at `http://localhost:5173/invoices/<id>`. Confirm the hero badge is now red, not purple.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ui/status-badge.tsx
git commit -m "feat(ui): change REFUNDED status badge to danger red"
```

---

## Task 3: InvoiceDetailPage — Types, Ledger, Totals Row, Tab Counter

**Files:**
- Modify: `frontend/src/pages/InvoiceDetailPage.tsx`

This is the main task. Three independent sub-sections within the same file.

### 3A — TypeScript types

- [ ] **Step 1: Extend the `InvoiceDetail` interface**

Find the `InvoiceDetail` interface (line ~71). After `voided_reason: string | null;`, add:

```ts
  refunded_at: string | null;
  total_refunded: number | string | null;
  refund_reason: string | null;
  refund_reason_category: string | null;
```

- [ ] **Step 2: Extend the nested deposit type**

Find the `deposit` sub-type inside `InvoiceDetail` (line ~122). The type is `{ ... } | null` — add the new fields inside the object shape, not at the `estimate` level. After `paid_at: string | null;`, add:

```ts
        refunded_at: string | null;
        surcharge_amount: number | string | null;
```

The full deposit type should then look like:
```ts
      deposit: {
        id: string;
        amount: number | string;
        status: string;
        total_refunded: number | string | null;
        payment_method: string | null;
        paid_at: string | null;
        refunded_at: string | null;
        surcharge_amount: number | string | null;
      } | null;
```

- [ ] **Step 3: Run TypeScript type check**

```bash
cd C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm-worktrees\stripe-9c\frontend
npx tsc --noEmit
```

Expected: 0 errors.

---

### 3B — Payments Tab: Full Chronological Ledger

The Payments tab currently iterates `invoice.payments` and shows Date, Amount, Method, Reference #, Collected By, Notes columns. Replace the entire tab content with a ledger that builds a unified event list from all cash sources.

- [ ] **Step 1: Add the `buildLedgerEvents` helper function**

Add this function near the other helpers at the top of the component file (after `isDepositCreditPayment`, before `getAvailableActions`):

```tsx
interface LedgerEvent {
  key: string;
  date: string;
  label: string;
  source: 'ESTIMATE' | 'INVOICE';
  estimateId?: string;
  estimateNumber?: string;
  method: string;
  amount: number;   // always positive
  sign: '+' | '−';
  by: string;
  isRefund: boolean;
}

function buildLedgerEvents(invoice: InvoiceDetail): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  const deposit = invoice.job.estimate?.deposit;
  const estimate = invoice.job.estimate;

  // 1. Deposit Paid
  if (deposit && deposit.status !== 'REQUESTED' && deposit.paid_at) {
    const surcharge = Number(deposit.surcharge_amount || 0);
    const total = Number(deposit.amount) + surcharge;
    events.push({
      key: 'deposit-paid',
      date: deposit.paid_at,
      label: 'Deposit Paid',
      source: 'ESTIMATE',
      estimateId: estimate?.id,
      estimateNumber: estimate?.estimate_number,
      method: deposit.payment_method || 'CARD',
      amount: total,
      sign: '+',
      by: 'Stripe',
      isRefund: false,
    });
  }

  // 2. Invoice payments (exclude deposit-credit rows)
  for (const p of invoice.payments) {
    if (p.reference_number === 'DEPOSIT-CREDIT') continue;
    events.push({
      key: p.id,
      date: p.paid_at,
      label: p.method === 'CARD' ? 'Invoice Paid' : 'Manual Payment',
      source: 'INVOICE',
      method: p.method,
      amount: Number(p.amount),
      sign: '+',
      by: p.collector
        ? `${p.collector.first_name} ${p.collector.last_name}`
        : p.method === 'CARD'
        ? 'Stripe'
        : '—',
      isRefund: false,
    });
  }

  // 3. Invoice Refunded
  if (invoice.status === 'REFUNDED' && invoice.refunded_at && invoice.total_refunded) {
    events.push({
      key: 'invoice-refunded',
      date: invoice.refunded_at,
      label: 'Invoice Refunded',
      source: 'INVOICE',
      method: 'CARD',
      amount: Number(invoice.total_refunded),
      sign: '−',
      by: '—', // refunded_by is not in schema; leave as dash for now
      isRefund: true,
    });
  }

  // 4. Deposit Refunded
  if (deposit && deposit.status === 'REFUNDED' && deposit.refunded_at && deposit.total_refunded) {
    const surcharge = Number(deposit.surcharge_amount || 0);
    const total = Number(deposit.total_refunded) + surcharge;
    events.push({
      key: 'deposit-refunded',
      date: deposit.refunded_at,
      label: 'Deposit Refunded',
      source: 'ESTIMATE',
      estimateId: estimate?.id,
      estimateNumber: estimate?.estimate_number,
      method: 'CARD',
      amount: total,
      sign: '−',
      by: 'Stripe',
      isRefund: true,
    });
  }

  // Sort chronologically
  events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return events;
}
```

- [ ] **Step 2: Replace the Payments tab content**

Find the entire `<TabsContent value="payments">` block (lines ~750–825) and replace its contents with the following. Keep the outer `<TabsContent value="payments" className="p-4">` wrapper tag.

```tsx
          {/* Payments Tab */}
          <TabsContent value="payments" className="p-4">
            {actions.canRecordPayment && (
              <div className="flex justify-end mb-4">
                <Button size="sm" onClick={() => setRecordPaymentOpen(true)}>
                  <DollarSign className="mr-2 h-4 w-4" /> Record Payment
                </Button>
              </div>
            )}

            {(() => {
              const ledger = buildLedgerEvents(invoice);
              const inbound = ledger.filter((e) => !e.isRefund);
              const outbound = ledger.filter((e) => e.isRefund);
              const hasRefunds = outbound.length > 0;
              const totalIn = inbound.reduce((s, e) => s + e.amount, 0);
              const totalOut = outbound.reduce((s, e) => s + e.amount, 0);
              const net = totalIn - totalOut;

              if (ledger.length === 0) {
                return (
                  <div className="text-center py-12">
                    <DollarSign className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                    <p className="text-sm font-medium text-text-primary mb-1">No payments recorded yet</p>
                    <p className="text-xs text-text-secondary mb-4">
                      Payments will appear here once recorded. Deposit credit is shown in the payment summary.
                    </p>
                    {actions.canRecordPayment && (
                      <Button size="sm" onClick={() => setRecordPaymentOpen(true)}>
                        <DollarSign className="mr-2 h-4 w-4" /> Record Payment
                      </Button>
                    )}
                  </div>
                );
              }

              const renderRow = (event: LedgerEvent) => (
                <tr
                  key={event.key}
                  className={cn(
                    'hover:bg-background-light/30',
                    event.isRefund && 'bg-red-50/40',
                  )}
                >
                  <td className="py-2.5 pr-3 whitespace-nowrap text-sm">
                    <span title={new Date(event.date).toLocaleString()}>
                      {new Date(event.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className={cn(
                      'flex items-center gap-2 pl-2 border-l-2',
                      event.isRefund ? 'border-red-400' : 'border-green-400',
                    )}>
                      <span className={cn('font-medium text-sm', event.isRefund ? 'text-red-700' : '')}>
                        {event.label}
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3">
                    {event.source === 'ESTIMATE' && event.estimateId ? (
                      <Link
                        to={`/estimates/${event.estimateId}`}
                        className="text-xs font-medium border border-border rounded px-1.5 py-0.5 hover:bg-background-light transition-colors"
                      >
                        {event.estimateNumber || 'ESTIMATE'}
                      </Link>
                    ) : (
                      <span className="text-xs font-medium border border-border rounded px-1.5 py-0.5 bg-background-light">
                        INVOICE
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge variant="outline" className="text-xs">
                      {event.method.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td className={cn(
                    'py-2.5 pr-3 text-right font-semibold tabular-nums text-sm',
                    event.isRefund ? 'text-red-600' : 'text-green-600',
                  )}>
                    {event.sign}{formatCurrency(event.amount)}
                  </td>
                  <td className="py-2.5 text-text-secondary text-sm">{event.by}</td>
                </tr>
              );

              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-text-secondary">
                        <th className="pb-2 pr-3">Date</th>
                        <th className="pb-2 pr-3">Event</th>
                        <th className="pb-2 pr-3">Source</th>
                        <th className="pb-2 pr-3">Method</th>
                        <th className="pb-2 pr-3 text-right">Amount</th>
                        <th className="pb-2">By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {inbound.map(renderRow)}
                      {hasRefunds && (
                        <>
                          <tr>
                            <td colSpan={6} className="py-1.5">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 border-t border-dashed border-red-200" />
                                <span className="text-xs font-medium text-red-500 uppercase tracking-wide">Refunds</span>
                                <div className="flex-1 border-t border-dashed border-red-200" />
                              </div>
                            </td>
                          </tr>
                          {outbound.map(renderRow)}
                        </>
                      )}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={6} className="pt-3 text-xs text-text-secondary text-right">
                          {ledger.length} event{ledger.length !== 1 ? 's' : ''} ·{' '}
                          <span className="text-green-600">+{formatCurrency(totalIn)} collected</span>
                          {hasRefunds && (
                            <>
                              {' · '}
                              <span className="text-red-600">−{formatCurrency(totalOut)} refunded</span>
                            </>
                          )}
                          {' · Net '}
                          <span className={net === 0 && hasRefunds ? 'text-text-secondary' : 'text-green-600'}>
                            {formatCurrency(net)}
                          </span>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              );
            })()}
          </TabsContent>
```

- [ ] **Step 3: Update the tab counter**

Find the Payments tab trigger (line ~623):
```tsx
<TabsTrigger value="payments" className={TAB_TRIGGER_CLASS}>
  Payments
  <span className="ml-1.5 text-xs text-text-secondary">({invoice.payments.length})</span>
</TabsTrigger>
```

Replace the count expression with a call to `buildLedgerEvents`:
```tsx
<TabsTrigger value="payments" className={TAB_TRIGGER_CLASS}>
  Payments
  <span className="ml-1.5 text-xs text-text-secondary">({buildLedgerEvents(invoice).length})</span>
</TabsTrigger>
```

---

### 3C — Totals Block: Refunded Row

- [ ] **Step 1: Find the totals section (Line Items tab)**

Locate the `paymentsTotal > 0` block (line ~733):
```tsx
{paymentsTotal > 0 && (
  <div className="flex gap-8 text-sm">
    <span className="text-text-secondary">Less payments applied</span>
    <span className="tabular-nums text-green-600">-{formatCurrency(paymentsTotal)}</span>
  </div>
)}
<div className="flex gap-8 text-base font-bold border-t pt-1 mt-1">
```

- [ ] **Step 2: Add the Refunded row between "Less payments applied" and "Balance Due"**

```tsx
{paymentsTotal > 0 && (
  <div className="flex gap-8 text-sm">
    <span className="text-text-secondary">Less payments applied</span>
    <span className="tabular-nums text-green-600">-{formatCurrency(paymentsTotal)}</span>
  </div>
)}
{Number(invoice.total_refunded) > 0 && (
  <div className="flex justify-between text-sm">
    <span className="text-text-secondary">Refunded</span>
    <span className="tabular-nums text-red-600">+{formatCurrency(Number(invoice.total_refunded))}</span>
  </div>
)}
<div className="flex gap-8 text-base font-bold border-t pt-1 mt-1">
```

- [ ] **Step 3: Run TypeScript type check**

```bash
cd C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm-worktrees\stripe-9c\frontend
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Manual smoke test — REFUNDED invoice**

With both servers running (worktree backend port 3000, worktree frontend port 5173):

1. Navigate to invoice I00002 (status: REFUNDED)
2. **Hero card:** Badge is red "Refunded" ✓
3. **Payments tab:** Shows 4 events — Deposit Paid, Invoice Paid, (Refunds divider), Invoice Refunded, Deposit Refunded ✓
4. **Payments tab counter:** Shows `(4)` ✓
5. **Payments tab footer:** `4 events · +$310.50 collected · −$310.50 refunded · Net $0.00` ✓
6. **Totals block (Line Items tab):** Shows red `Refunded +$150.00` row ✓

- [ ] **Step 5: Manual smoke test — normal PAID invoice**

Navigate to any PAID invoice (no refunds).

1. **Payments tab:** Shows same rows as before (deposit-credit hidden, card payment shown) — no divider, no extra rows ✓
2. **Totals block:** No "Refunded" row visible ✓

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/InvoiceDetailPage.tsx
git commit -m "feat(invoices): full financial ledger in payments tab + refunded row in totals"
```

---

## Final verification

- [ ] Run full backend test suite one last time: `npm test --workspace=backend` from the worktree root — all tests pass (confirm exact count against pre-task baseline; worktree may be at 688 or slightly different)
- [ ] Run frontend type check: `npx tsc --noEmit` from `frontend/` — 0 errors
- [ ] All 8 acceptance criteria from the spec are met (see spec file)
