# Step 8B: Invoice & Payments Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete invoicing & payments frontend — list page, detail page, public payment page, dialogs, and cross-entity wiring — on top of the Step 8A backend (12 endpoints, 591 tests).

**Architecture:** Three new pages (InvoicesPage, InvoiceDetailPage, PublicInvoicePage), two new dialogs (RecordPaymentDialog, VoidInvoiceDialog), and wiring into existing pages (JobDetailPage "Create Invoice" button, CustomerDetailPage Invoices tab, App.tsx routes). All follow established patterns: TanStack Query for data, plain useState for dialog forms, useMutation for actions, DataTable for lists, shadcn/ui components throughout.

**Tech Stack:** React 18 + TypeScript + TanStack Query + TanStack Table v8 + shadcn/ui + Tailwind + Axios + React Router v6

**Spec:** `md_files/specs/invoices/invoice-payments-design.md` §7 (Frontend)

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `frontend/src/pages/InvoicesPage.tsx` | Invoice list — KPI strip, DataTable, filters, search, export |
| `frontend/src/pages/InvoiceDetailPage.tsx` | Invoice detail — hero, payment waterfall, tabs (Line Items / Payments / Notes), actions |
| `frontend/src/pages/PublicInvoicePage.tsx` | Public invoice page — token-validated, Stripe checkout, payment states |
| `frontend/src/components/invoices/RecordPaymentDialog.tsx` | Record manual payment form (amount, method, date, ref#, notes) |
| `frontend/src/components/invoices/VoidInvoiceDialog.tsx` | Void invoice with reason (destructive, Admin only) |
| `frontend/src/components/invoices/SendInvoiceDialog.tsx` | Confirm send with due date display |

### Modified Files
| File | Change |
|------|--------|
| `frontend/src/App.tsx` | Add routes: `/invoices/:id`, `/p/invoices/:id` |
| `frontend/src/components/layout/nav-config.ts` | Add TECHNICIAN + SALES roles to Invoices nav item |
| `frontend/src/pages/JobDetailPage.tsx` | "Create Invoice" button + "View Invoice" link for completed jobs |
| `frontend/src/pages/CustomerDetailPage.tsx` | Wire Invoices tab to fetch from `/api/invoices?customer_job_ids=...` or derive from existing jobs data |

---

## Task 1: Routes & Navigation Wiring

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/layout/nav-config.ts`

- [ ] **Step 1: Add lazy imports and routes to App.tsx**

Add the two new page imports and routes:

```tsx
// After existing lazy imports (line ~27)
const InvoiceDetailPage = lazy(() => import('@/pages/InvoiceDetailPage'));
const PublicInvoicePage = lazy(() => import('@/pages/PublicInvoicePage'));
```

Add routes:
```tsx
// After <Route path="/invoices" ...> (line 77), add:
<Route path="/invoices/:id" element={<InvoiceDetailPage />} />

// After <Route path="/p/estimates/:id" ...> (line 56), add:
<Route path="/p/invoices/:id" element={<PublicInvoicePage />} />
```

- [ ] **Step 2: Update nav-config.ts roles**

The Invoices nav item currently has `roles: ['ADMIN', 'DISPATCHER']`. Update to include all roles that can view invoices:

```ts
{ label: 'Invoices', href: '/invoices', icon: Receipt, roles: ['ADMIN', 'DISPATCHER', 'TECHNICIAN', 'SALES'] }
```

- [ ] **Step 3: Create placeholder InvoiceDetailPage and PublicInvoicePage**

Create minimal placeholder files so routes don't break:

`frontend/src/pages/InvoiceDetailPage.tsx`:
```tsx
export default function InvoiceDetailPage() {
  return <div className="p-4">Invoice Detail — coming soon</div>;
}
```

`frontend/src/pages/PublicInvoicePage.tsx`:
```tsx
export default function PublicInvoicePage() {
  return <div className="p-8">Public Invoice — coming soon</div>;
}
```

- [ ] **Step 4: Verify dev server compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/layout/nav-config.ts frontend/src/pages/InvoiceDetailPage.tsx frontend/src/pages/PublicInvoicePage.tsx
git commit -m "feat: add invoice routes and nav wiring"
```

---

## Task 2: InvoicesPage — KPI Strip + DataTable

**Files:**
- Modify: `frontend/src/pages/InvoicesPage.tsx`

**Reference patterns:** `EstimatesPage.tsx` (KPI strip + DataTable + filters), `JobsPage.tsx` (same pattern)

**API:** `GET /api/invoices` returns `{ invoices, pagination, stats }` where stats has: `due` (total + count), `overdue` (total + count), `collected_this_month` (total + count), `unsent` (count), `need_invoices` (count)

- [ ] **Step 1: Define TypeScript interfaces**

At the top of InvoicesPage.tsx, define:

```tsx
interface InvoiceListItem {
  id: string;
  invoice_number: string;
  status: string;
  subtotal: number | string;
  discount_amount: number | string;
  tax_amount: number | string;
  deposit_credit: number | string;
  total_amount: number | string;
  amount_due: number | string;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  job: {
    id: string;
    job_number: string;
    customer: {
      id: string;
      first_name: string;
      last_name: string;
      company_name: string | null;  // Included in backend invoiceListSelect response
    };
  };
}

interface InvoiceStats {
  due: { total: number; count: number };
  overdue: { total: number; count: number };
  collected_this_month: { total: number; count: number };
  unsent: number;
  need_invoices: number;
}
```

- [ ] **Step 2: Build the query hook and KPI strip**

Use `useQuery` to fetch from `/api/invoices` with search, status, date range, overdue, sorting, and pagination params. Build the 5-cell KPI strip following the established pattern (single card, `divide-x`, `text-3xl font-bold tabular-nums` values):

| Cell | Icon | Label | Value | Color |
|------|------|-------|-------|-------|
| Due | DollarSign | Outstanding | `formatCurrency(stats.due.total)` + count | blue |
| Overdue | AlertTriangle | Overdue | `formatCurrency(stats.overdue.total)` + count | red (text-red-600) |
| Collected | CheckCircle2 | Collected (Month) | `formatCurrency(stats.collected_this_month.total)` + count | emerald |
| Unsent | FileText | Unsent Drafts | count | amber (warn when > 0) |
| Need Invoices | Package | Need Invoices | count | gray |

- [ ] **Step 3: Build column definitions**

Define columns using `ColumnDef<InvoiceListItem>[]`. Key columns:

| Column | size | minSize | Sortable | Cell renderer |
|--------|------|---------|----------|--------------|
| Invoice # | 120 | 100 | Yes (`invoice_number`) | Link to `/invoices/:id` |
| Customer | 180 | 140 | No | `last_name, first_name` (link to customer) |
| Job | 100 | 80 | No | Link to `/jobs/:id` |
| Status | 110 | 90 | Yes (`status`) | `<StatusBadge>` — show "OVERDUE" when due_date < today & status SENT/PARTIAL |
| Subtotal | 100 | 80 | No | `formatCurrency()` right-aligned |
| Discount | 90 | 70 | No | `formatCurrency()` right-aligned, show "-" if 0 |
| Tax | 80 | 70 | No | `formatCurrency()` right-aligned |
| Deposit Credit | 100 | 80 | No | `formatCurrency()` right-aligned, show "-" if 0 |
| Total | 110 | 90 | Yes (`total_amount`) | `formatCurrency()` right-aligned |
| Amount Due | 120 | 100 | Yes (`amount_due`) | `formatCurrency()` right-aligned, bold if > 0 |
| Due Date | 120 | 100 | Yes (`due_date`) | formatted date, `text-red-600` if overdue |
| Created | 110 | 90 | Yes (`created_at`) | formatted date |

**Note:** The Subtotal, Discount, Tax, and Deposit Credit columns should default to hidden via column visibility toggle (too many columns for most screens). Users can show them from the column visibility popover. The 8 default-visible columns are: Invoice #, Customer, Job, Status, Total, Amount Due, Due Date, Created.

- [ ] **Step 4: Build filter toolbar**

Following the unified filtering pattern:
- **Status** multi-select: DRAFT, SENT, PARTIAL, PAID, VOIDED
- **Overdue** toggle (boolean filter)
- **Date range**: created_after / created_before
- **Search** input (invoice #, customer name, job #)
- FilterChip components above table for active filters with "Clear all"
- CSV export button
- Page size selector (25/50/100)

- [ ] **Step 5: Assemble the full page**

Wire everything together:
- Page heading "Invoices" with total count
- KPI strip card
- Filter toolbar
- DataTable with sorting, column visibility, pagination
- Row click navigates to `/invoices/:id`

- [ ] **Step 6: Verify compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/InvoicesPage.tsx
git commit -m "feat: build InvoicesPage with KPI strip, DataTable, filters"
```

---

## Task 3: RecordPaymentDialog

**Files:**
- Create: `frontend/src/components/invoices/RecordPaymentDialog.tsx`

**Reference pattern:** `MarkDepositReceivedDialog.tsx` (plain useState form + useMutation)

**API:** `POST /api/invoices/:id/payments` — body: `{ amount, method, paid_at?, reference_number?, notes? }`

- [ ] **Step 1: Build the dialog component**

Props:
```tsx
interface RecordPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  invoiceNumber: string;
  amountDue: number;
  onSuccess: () => void;
}
```

Form state (useState, not RHF — matches existing dialog pattern):
- `amount`: number, pre-filled with `amountDue`
- `method`: string, default `'CASH'`
- `paidAt`: string, default today (`new Date().toISOString().slice(0, 16)`)
- `referenceNumber`: string, optional
- `notes`: string, optional

Layout:
- Amount input (number, max = amountDue, step 0.01). Show "Max: $X" helper text.
- Payment method select: Cash, Check, Card, Bank Transfer
- Date input (datetime-local, defaults to now)
- Reference # input (optional — show placeholder "Check #, transaction ID, etc.")
- Notes textarea (optional)
- Cancel + "Record Payment" buttons (primary variant)

Mutation: `POST /api/invoices/${invoiceId}/payments` → onSuccess: call `onSuccess()` prop (which invalidates queries from parent)

- [ ] **Step 2: Verify compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/invoices/RecordPaymentDialog.tsx
git commit -m "feat: add RecordPaymentDialog component"
```

---

## Task 4: VoidInvoiceDialog

**Files:**
- Create: `frontend/src/components/invoices/VoidInvoiceDialog.tsx`

**Reference pattern:** `CancelEstimateDialog.tsx` (destructive action with required reason)

**API:** `POST /api/invoices/:id/void` — body: `{ voided_reason }`

- [ ] **Step 1: Build the dialog component**

Props:
```tsx
interface VoidInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  invoiceNumber: string;
  onSuccess: () => void;
}
```

Form state:
- `reason`: string (required, min 1 char)

Layout:
- Warning banner: "Voiding invoice {number} will preserve the record but mark it as cancelled. This action cannot be undone."
- Reason textarea (required)
- Cancel + "Void Invoice" buttons (destructive variant, red)

Mutation: `POST /api/invoices/${invoiceId}/void` with `{ voided_reason: reason }` → onSuccess: call `onSuccess()`

- [ ] **Step 2: Verify compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/invoices/VoidInvoiceDialog.tsx
git commit -m "feat: add VoidInvoiceDialog component"
```

---

## Task 5: SendInvoiceDialog

**Files:**
- Create: `frontend/src/components/invoices/SendInvoiceDialog.tsx`

**API:** `POST /api/invoices/:id/send`

- [ ] **Step 1: Build the dialog component**

Props:
```tsx
interface SendInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  invoiceNumber: string;
  customerEmail: string;
  dueDate: string | null;
  totalAmount: number;
  amountDue: number;
  onSuccess: () => void;
}
```

Layout (confirmation dialog, minimal):
- "Send Invoice {number}" title
- Summary: "This will email invoice {number} to {customerEmail}."
- Display: Amount Due: $X, Due Date: {formatted date}
- Cancel + "Send Invoice" buttons (primary variant with Send icon)

Mutation: `POST /api/invoices/${invoiceId}/send` → onSuccess: call `onSuccess()`

- [ ] **Step 2: Verify compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/invoices/SendInvoiceDialog.tsx
git commit -m "feat: add SendInvoiceDialog component"
```

---

## Task 6: InvoiceDetailPage — Hero + Actions + Tabs

**Files:**
- Modify: `frontend/src/pages/InvoiceDetailPage.tsx` (replace placeholder)

**Reference patterns:** `EstimateDetailPage.tsx` (hero + tabs + actions), `JobDetailPage.tsx` (getAvailableActions pattern)

**API:** `GET /api/invoices/:id` returns full invoice with job, customer, estimate line items, job charges, payments, deposit info

This is the largest task. It has three sections: hero card, payment waterfall, and tabs.

- [ ] **Step 1: Define types and helpers**

```tsx
interface InvoiceDetail {
  id: string;
  invoice_number: string;
  status: string;
  subtotal: number | string;
  discount_amount: number | string;
  tax_rate: number | string;
  tax_amount: number | string;
  deposit_credit: number | string;
  total_amount: number | string;
  amount_due: number | string;
  public_token: string | null;
  sent_at: string | null;
  paid_at: string | null;
  due_date: string | null;
  voided_at: string | null;
  voided_reason: string | null;
  created_at: string;
  updated_at: string;
  job: {
    id: string;
    job_number: string;
    status: string;
    is_urgent: boolean;
    assigned_to: string | null;
    customer: {
      id: string;
      first_name: string;
      last_name: string;
      email: string;
      phone: string;
      payment_type: string | null;
      tax_exempt: boolean;
    };
    service_location: {
      id: string;
      address_line1: string;
      address_line2: string | null;
      city: string;
      state: string;
      zip: string;
    };
    estimate: {
      id: string;
      estimate_number: string;
      tax_rate: number | string;
      discount_amount: number | string;
      discount_type: string | null;
      discount_value: number | string | null;
      discount_name: string | null;
      line_items: LineItem[];
      deposit: {
        id: string;
        amount: number | string;
        status: string;
        total_refunded: number | string | null;
        payment_method: string | null;
        paid_at: string | null;
      } | null;
      lead: { id: string; assigned_to: string | null } | null;
    } | null;
    charges: LineItem[];
  };
  payments: Payment[];
}

interface LineItem {
  id: string;
  sequence: number;
  description: string;
  quantity: number;
  unit_price: number | string;
  is_taxable: boolean;
  line_total: number | string;
}

interface Payment {
  id: string;
  amount: number | string;
  method: string;
  paid_at: string;
  collected_by: string | null;
  stripe_payment_intent_id: string | null;
  reference_number: string | null;
  notes: string | null;
  created_at: string;
  collector: { id: string; first_name: string; last_name: string } | null;
}
```

Helper: `getAvailableActions(invoice, userRole, userId)` returns:
```tsx
const isPayable = invoice.status === 'SENT' || invoice.status === 'PARTIAL';
const isDraft = invoice.status === 'DRAFT';
const canManage = role === 'ADMIN' || role === 'DISPATCHER';
const isOwnJob = invoice.job.assigned_to === userId;

return {
  canSend: isDraft && canManage,
  canRecordPayment: isPayable && (canManage || (role === 'TECHNICIAN' && isOwnJob)),
  canVoid: isPayable && role === 'ADMIN',
  canDelete: isDraft && canManage,
  canEdit: isDraft && canManage,
  canAddNotes: canManage || (role === 'TECHNICIAN' && isOwnJob),
  canCopyLink: !!invoice.public_token,
};
```
```

Helper: `isOverdue(invoice)` — `due_date < today && (status === 'SENT' || status === 'PARTIAL')`

Helper: `getDueDateLabel(invoice)` — returns "X days left" or "X days overdue" string

- [ ] **Step 2: Build hero card**

Layout (matches existing detail page pattern — breadcrumb above, hero card separate):

**Breadcrumb:** Invoices > {invoice_number} (context-aware via `location.state?.breadcrumbs`)

**Hero card contents:**
- Left side:
  - Invoice # (text-sm text-text-secondary) + StatusBadge (show "OVERDUE" when overdue)
  - Customer name (link to `/customers/:id`) + phone (`formatPhone()`) + email
  - Job site address (from job.service_location)
  - Links row: Job {job_number} (link) + Estimate {estimate_number} (link, if exists)
  - Dates: Sent {date} · Due {date} ({getDueDateLabel})
- Right side:
  - Amount due as hero number (`text-3xl font-bold tabular-nums`, `text-red-600` if overdue)
  - Label "Amount Due" below
- Action buttons:
  - Primary CTA: DRAFT → "Send Invoice" (Send icon), SENT/PARTIAL → "Record Payment" (DollarSign icon)
  - Overflow DropdownMenu (MoreHorizontal): Void (destructive, Admin), Delete (destructive, DRAFT), Copy Public Link, Print

**Overdue banner:** When `isOverdue(invoice)`, show red alert bar below hero: AlertTriangle icon + "OVERDUE — X days past due (was due {formatted date})"

**Voided banner:** When status === 'VOIDED', show gray alert: "This invoice was voided on {date}: {reason}"

- [ ] **Step 3: Build payment waterfall card**

Below hero card. Single card showing payment progress:

```
Invoice Total: $1,200.00
- Deposit Credit: -$300.00
- Payments (2): -$450.00
───────────────────────────
= Balance Due: $450.00
```

Progress bar: `(total_amount - amount_due) / total_amount * 100`%, color-coded (gray when 0%, blue partial, green when 100%).

Collapse payment detail rows if > 4 payments: show "Payments Applied -$X (N payments)" with "View all" link that switches to Payments tab.

- [ ] **Step 4: Build Line Items tab**

Unified table showing both estimate line items and job charges:

| # | Description | Source | Qty | Unit Price | Taxable | Line Total |
|---|-------------|--------|-----|------------|---------|------------|

Source column: gray "Estimate" badge for estimate items, amber "Job" badge for charges.

Below the table, right-aligned totals:
```
Subtotal:                    $1,400.00
Discount (Early Bird -10%):   -$140.00
Tax (8.25%):                   $104.03
────────────────────────────────────────
Invoice Total:               $1,364.03
Less deposit credit:          -$300.00
Less payments applied:        -$450.00
────────────────────────────────────────
Balance Due:                   $614.03
```

- [ ] **Step 5: Build Payments tab**

Table showing payment history:

| Date | Amount | Method | Reference # | Collected By | Notes |
|------|--------|--------|-------------|-------------|-------|

Show "Record Payment" button at top-right (if `canRecordPayment`).

Empty state: centered card with DollarSign icon + "No payments recorded yet" + Record Payment button.

- [ ] **Step 6: Build Notes tab**

Same polymorphic notes pattern as EstimateDetailPage/JobDetailPage:
- `GET /api/invoices/:id/notes` to fetch
- `POST /api/invoices/:id/notes` to add
- Textarea + Add Note button (if `canAddNotes`)
- Note cards with creator name, date, content

- [ ] **Step 7: Wire dialogs and mutations**

Connect:
- SendInvoiceDialog → `POST /api/invoices/:id/send` → invalidate query
- RecordPaymentDialog → opens with `amountDue` → invalidate query on success
- VoidInvoiceDialog → `POST /api/invoices/:id/void` → invalidate + navigate to list
- Delete mutation → `DELETE /api/invoices/:id` → navigate to `/invoices`
- Copy public link → `navigator.clipboard.writeText(...)` → toast/alert

- [ ] **Step 8: Build skeleton loading state**

Layout-faithful skeleton matching the hero + waterfall + tabs structure. Follow `EstimateDetailPage` skeleton pattern.

- [ ] **Step 9: Verify compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add frontend/src/pages/InvoiceDetailPage.tsx
git commit -m "feat: build InvoiceDetailPage with hero, waterfall, tabs, actions"
```

---

## Task 7: PublicInvoicePage

**Files:**
- Modify: `frontend/src/pages/PublicInvoicePage.tsx` (replace placeholder)

**Reference pattern:** `PublicEstimatePage.tsx` (no-auth, raw fetch, token-validated, Stripe checkout redirect)

**API:** `GET /api/invoices/:id/public?token=X`, `POST /api/invoices/:id/public/checkout?token=X`

- [ ] **Step 1: Define types**

```tsx
interface PublicInvoice {
  id: string;
  invoice_number: string;
  status: string;
  subtotal: number | string;
  discount_amount: number | string;
  tax_amount: number | string;
  deposit_credit: number | string;
  total_amount: number | string;
  amount_due: number | string;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  job: {
    job_number: string;
    estimate: {
      estimate_number: string;
      discount_name: string | null;
      discount_type: string | null;
      discount_value: number | string | null;
      tax_rate: number | string;
      line_items: PublicLineItem[];
    } | null;
    charges: PublicLineItem[];
    customer: { first_name: string; last_name: string; email: string; phone: string };
    service_location: { address_line1: string; address_line2: string | null; city: string; state: string; zip: string };
  };
  payments: { id: string; amount: number | string; method: string; paid_at: string }[];
}

interface PublicLineItem {
  id: string;
  sequence: number;
  description: string;
  quantity: number;
  unit_price: number | string;
  is_taxable: boolean;
  line_total: number | string;
}
```

- [ ] **Step 2: Build fetch logic and state machine**

Use raw `fetch` (no Axios — public page has no auth token). Read `token` from URL search params.

States:
- `loading` — Spinner
- `error` — Error card
- `voided` — "This invoice has been voided" card
- `paid` — Payment receipt (green CheckCircle2, payment history, "Paid in Full")
- `payable` (SENT/PARTIAL) — Full invoice view with Pay button
- `stripe_success` — Green banner "Payment received! It may take a moment to process."
- `stripe_cancelled` — Amber banner "Payment was cancelled. You can try again."

Read `payment` query param for Stripe return states.

- [ ] **Step 3: Build the invoice document view**

For the `payable` and `paid` states, render a professional invoice document:

- Header: "INVOICE" title + invoice number + dates (sent, due)
- Customer info block: name, address
- Line items table with Source tags (Estimate/Job)
- Totals section: Subtotal → Discount → Tax → Total → Deposit Credit → Payments → **Amount Due** (bold, large)
- Payment history section (if any partial payments exist)

- [ ] **Step 4: Build the Pay by Card section**

For `payable` state, below the invoice document:
- Card with CreditCard icon
- "Pay by Card" heading
- Amount breakdown: "Invoice balance: $X + Card processing fee: $Y = Total: $Z"
- "Pay $Z by Card" button (primary) → calls `POST /api/invoices/:id/public/checkout?token=X` → redirect to `checkout_url`
- "Other payment methods" note: "Contact us to arrange payment by check, cash, or bank transfer."
- Loading state on button during checkout creation

- [ ] **Step 5: Verify compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/PublicInvoicePage.tsx
git commit -m "feat: build PublicInvoicePage with Stripe checkout"
```

---

## Task 8: JobDetailPage — Create Invoice Wiring

**Files:**
- Modify: `frontend/src/pages/JobDetailPage.tsx`

- [ ] **Step 1: Add Create Invoice to getAvailableActions**

Add new capability:
```tsx
canCreateInvoice: (role === 'ADMIN' || role === 'DISPATCHER' || (role === 'TECHNICIAN' && job.assigned_to === userId))
  && job.status === 'COMPLETED'
  && (!job.invoice || job.invoice.status === 'VOIDED'),
```

- [ ] **Step 2: Add Create Invoice button and View Invoice link**

In the action buttons section:

If `canCreateInvoice` — show "Create Invoice" button (Receipt icon, primary variant).
If `job.invoice && job.invoice.status !== 'VOIDED'` — show "View Invoice" link button (navigates to `/invoices/${job.invoice.id}` with breadcrumb state).

Create Invoice mutation:
```tsx
const createInvoiceMutation = useMutation({
  mutationFn: () => api.post('/api/invoices', { job_id: job.id }),
  onSuccess: (res) => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    navigate(`/invoices/${res.data.invoice.id}`);
  },
});
```

- [ ] **Step 3: Add invoice info to the Details tab**

In the Details tab key-value section, when `job.invoice` exists, add:
- Invoice: link to `/invoices/${job.invoice.id}` showing `job.invoice.invoice_number`
- Invoice Status: StatusBadge
- Invoice Total: `formatCurrency(job.invoice.total_amount)`

- [ ] **Step 4: Verify compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/JobDetailPage.tsx
git commit -m "feat: wire Create Invoice button into JobDetailPage"
```

---

## Task 9: CustomerDetailPage — Invoices Tab

**Files:**
- Modify: `frontend/src/pages/CustomerDetailPage.tsx`

- [ ] **Step 1: Verify existing InvoicesTab**

The CustomerDetailPage already has an InvoicesTab component that derives invoices from the job data. Read the current implementation and determine if it needs updates to:
- Show all invoice columns (number, status, total, amount due, due date)
- Link to `/invoices/:id`
- Show overdue styling

If the existing tab is sufficient, just verify it works. If it needs enhancement, update it to show a proper mini-table with the key invoice fields.

- [ ] **Step 2: Verify tab count subtitle**

Ensure the Invoices tab shows the correct count subtitle (e.g., "3 invoices").

- [ ] **Step 3: Verify compilation**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit (if changes made)**

```bash
git add frontend/src/pages/CustomerDetailPage.tsx
git commit -m "feat: enhance CustomerDetailPage invoices tab"
```

---

## Task 10: Final Integration & Type-Check

**Files:** All modified files

- [ ] **Step 1: Full type-check**

Run: `cd frontend && npx tsc --noEmit`
Fix any remaining type errors.

- [ ] **Step 2: Verify backend tests still pass**

Run: `cd backend && npm test`
Expected: 591 tests passing (no backend changes in this step, but verify nothing broke)

- [ ] **Step 3: Manual smoke test checklist**

Verify these flows work with dev servers running:
- [ ] Navigate to /invoices — KPI strip loads, table renders
- [ ] Filter by status, search, date range
- [ ] Click an invoice row → detail page loads
- [ ] On a completed job, click "Create Invoice" → navigates to new invoice detail
- [ ] On DRAFT invoice, click "Send Invoice" → status changes to SENT
- [ ] On SENT invoice, click "Record Payment" → dialog opens, submit works
- [ ] On SENT invoice (Admin), click Void → dialog opens, submit works
- [ ] Visit public invoice URL → document renders, Pay by Card works
- [ ] Customer detail → Invoices tab shows related invoices

- [ ] **Step 4: Update CLAUDE.md build progress**

Mark Step 8B as complete:
```
- [x] Step 8B: Invoicing & Payments — Frontend (InvoicesPage, InvoiceDetailPage, PublicInvoicePage, dialogs)
```

Update directory structure section with new files.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete Step 8B invoice frontend integration"
```

---

## Dependency Graph

```
Task 1 (Routes) ─┬─→ Task 2 (InvoicesPage)
                  ├─→ Task 3 (RecordPaymentDialog) ─┐
                  ├─→ Task 4 (VoidInvoiceDialog) ───┼─→ Task 6 (InvoiceDetailPage)
                  ├─→ Task 5 (SendInvoiceDialog) ───┘
                  ├─→ Task 7 (PublicInvoicePage)
                  ├─→ Task 8 (JobDetailPage wiring)
                  └─→ Task 9 (CustomerDetailPage) ──→ Task 10 (Integration)
```

**Parallelizable:** Tasks 2-5, 7, 8, 9 can all run in parallel after Task 1. Task 6 depends on Tasks 3-5 (imports dialog components). Task 10 is the final integration gate after all other tasks complete.
