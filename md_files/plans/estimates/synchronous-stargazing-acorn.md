# P1 Estimates: Terms & Conditions + Digital Signature

## Context

P0 estimates are complete (289 tests passing). P1 adds one feature: before a customer can approve an estimate, they must agree to terms & conditions and draw a digital signature. The signature is stored with their IP and timestamp, and displayed post-approval on both the public page and internal detail page.

Branch: `feature/estimates-p1` off `main`.

---

## Step 0: Create Branch

```bash
git checkout -b feature/estimates-p1
```

---

## Phase 1: Schema — `backend/prisma/schema.prisma`

### Add to `Estimate` model
```prisma
signature_data  String?   // base64 image (data:image/...)
signature_ip    String?
signature_at    DateTime?
```

### Migrate
```bash
cd backend && npx prisma migrate dev --name p1-estimate-signature
```
All fields nullable — safe migration, no data loss.

**Verify:** `npx prisma validate` + `npm test --workspace=backend` (all 289 tests still pass)

---

## Phase 2: Backend Logic — `backend/src/controllers/estimate.controller.ts`

### 2a. Update Select Objects

**`estimateDetailSelect`** — add to estimate-level:
```typescript
signature_data: true, signature_ip: true, signature_at: true,
```

**`estimatePublicSelect`** — add to estimate-level:
```typescript
signature_data: true, signature_at: true,
// signature_ip intentionally excluded — internal only
```

### 2b. Update `getPublic()` (line ~869)
After fetching estimate, also fetch AppSetting for terms:
```typescript
const termsSetting = await prisma.appSetting.findUnique({ where: { key: 'estimate_terms' } });
res.json({ estimate, terms: termsSetting?.value ?? null });
```

### 2c. Update `approvePublic()` (line ~894)

**Add body schema** at top of file:
```typescript
const approvePublicSchema = z.object({
  signature_data: z.string().min(1, 'Signature is required'),
});
```

**Handler changes** (in order):
1. Parse body with `approvePublicSchema` via `z.safeParse` → 400 if invalid
2. Validate `signature_data` starts with `data:image/` → 400 "Invalid signature format"
3. Capture IP: `const signatureIp = req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || null`
4. Add to the estimate update inside the transaction:
```typescript
signature_data: body.signature_data,
signature_ip:   signatureIp,
signature_at:   new Date(),
```
5. Fire-and-forget email block is unchanged

**Note:** `approvePublic` is a public route (no `validate()` middleware). Use inline `z.safeParse()` directly in the handler.

---

## Phase 3: Backend Tests — `backend/src/__tests__/estimates.test.ts`

### Update `helpers.ts`
Add to `ESTIMATE_FIXTURE` and `ESTIMATE_SENT_FIXTURE`:
```typescript
signature_data: null, signature_ip: null, signature_at: null,
```

### New tests (~10) in the `POST /api/estimates/:id/approve` describe block:
- Returns 400 when `signature_data` missing from body
- Returns 400 when `signature_data` doesn't start with `data:image/`
- Stores `signature_data`, `signature_ip`, `signature_at` in transaction update
- Still approves successfully with valid `signature_data`
- `estimateDetailSelect` includes all three signature fields
- `estimatePublicSelect` includes `signature_data` + `signature_at`, excludes `signature_ip`

### New tests (~4) in the `GET /api/estimates/:id/public` describe block:
- Returns `terms` from AppSetting `estimate_terms`
- Returns `terms: null` when AppSetting not set
```typescript
// Mock pattern:
mockPrisma.appSetting.findUnique.mockResolvedValue({ key: 'estimate_terms', value: 'Pay within 30 days.' });
```

**Verify:** `npm test --workspace=backend` — all ~303+ tests pass

---

## Phase 4: Frontend

### Install
```bash
npm install react-signature-canvas @types/react-signature-canvas --workspace=frontend
```

### 4a. `PublicEstimatePage.tsx` (primary changes)

**Update `PublicEstimate` interface:**
```typescript
signature_data?: string | null;
signature_at?: string | null;
// terms comes from top-level response (not estimate object)
```

**New state:**
```typescript
const [terms, setTerms] = useState<string | null>(null);
const [termsAgreed, setTermsAgreed] = useState(false);
const sigCanvasRef = useRef<SignatureCanvas>(null);
const [sigDrawn, setSigDrawn] = useState(false);
```

**Fetch update** — also set `terms` from response:
```typescript
setEstimate(data.estimate);
setTerms(data.terms ?? null);
```

**Terms section** — render above action buttons when `terms` exists and estimate is actionable:
```tsx
{terms && isActionable && (
  <Card className="p-4">
    <h3 className="text-sm font-semibold mb-2">Terms & Conditions</h3>
    <div className="text-xs text-gray-600 max-h-32 overflow-y-auto whitespace-pre-wrap mb-3 border rounded p-2">
      {terms}
    </div>
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <Checkbox checked={termsAgreed} onCheckedChange={(v) => setTermsAgreed(!!v)} />
      I agree to the terms and conditions
    </label>
  </Card>
)}
```

**Signature pad** — render above action buttons when actionable:
```tsx
{isActionable && (
  <Card className="p-4">
    <h3 className="text-sm font-semibold mb-2">
      Signature <span className="text-red-500">*</span>
    </h3>
    <div className="border rounded-lg overflow-hidden bg-white">
      <SignatureCanvas
        ref={sigCanvasRef}
        canvasProps={{ className: 'w-full h-32' }}
        onEnd={() => setSigDrawn(true)}
      />
    </div>
    <Button
      size="sm" variant="ghost" className="mt-1 text-xs"
      onClick={() => { sigCanvasRef.current?.clear(); setSigDrawn(false); }}
    >
      Clear
    </Button>
  </Card>
)}
```

**Post-approval signature display** — below status banner when approved:
```tsx
{estimate.signature_data && estimate.status === 'APPROVED' && (
  <Card className="p-4">
    <p className="text-xs font-medium text-gray-500 mb-2">Customer Signature</p>
    <img src={estimate.signature_data} alt="Signature" className="max-h-20 border rounded bg-white" />
    {estimate.signature_at && (
      <p className="text-xs text-gray-400 mt-1">
        Signed {new Date(estimate.signature_at).toLocaleString()}
      </p>
    )}
  </Card>
)}
```

**Approve button** — disable until signature drawn (and terms agreed if terms present):
```tsx
<Button
  disabled={!sigDrawn || (!!terms && !termsAgreed) || actionLoading}
  onClick={() => setConfirmAction('approve')}
>
  Approve Estimate
</Button>
```

**`handleAction` update** — send body for approve action:
```typescript
const body = action === 'approve'
  ? JSON.stringify({ signature_data: sigCanvasRef.current!.toDataURL('image/png') })
  : undefined;

const res = await fetch(`/api/estimates/${id}/${action}?token=${encodeURIComponent(token!)}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});
```

### 4b. `EstimateDetailPage.tsx`

**Update `LineItem` type** — no changes needed (signature is on estimate, not line items)

**Add signature display** in the Details tab, after the existing date/meta fields, when approved:
```tsx
{est.signature_data && est.status === 'APPROVED' && (
  <div className="border-t pt-4 mt-2">
    <p className="text-xs font-medium text-text-secondary mb-2">Customer Signature</p>
    <img src={est.signature_data} alt="Customer signature"
      className="border rounded-lg max-h-24 bg-white" />
    {est.signature_at && (
      <p className="text-xs text-text-secondary mt-1">
        Signed {new Date(est.signature_at).toLocaleString()}
      </p>
    )}
  </div>
)}
```

**Update estimate type** — add: `signature_data?: string | null`, `signature_at?: string | null`

**Verify:**
```bash
cd frontend && npx tsc --noEmit
```
Manual test:
- Create estimate → send → open public link
- Verify signature pad appears, approve button disabled until signed
- With `estimate_terms` AppSetting set: verify terms card appears, approve blocked until agreed
- Approve → verify signature image appears on public page and on detail page Details tab
- Verify `signature_ip` NOT visible on public page

---

## Implementation Order

```
1.  git checkout -b feature/estimates-p1
2.  Schema: add 3 fields to Estimate, migrate
3.  Backend: update selects (detail + public)
4.  Backend: getPublic — add terms fetch
5.  Backend: approvePublic — add signature validation + storage
6.  Backend tests (~14 new) — npm test, all pass
7.  npm install react-signature-canvas
8.  Frontend: PublicEstimatePage (terms + signature pad + updated handleAction)
9.  Frontend: EstimateDetailPage (signature display in Details tab)
10. npx tsc --noEmit — no errors
11. Manual QA
12. Commit + PR to main
```

## Critical Files

| File | Changes |
|------|---------|
| `backend/prisma/schema.prisma` | +3 nullable fields on Estimate |
| `backend/src/controllers/estimate.controller.ts` | selects, getPublic (terms), approvePublic (signature) |
| `backend/src/__tests__/helpers.ts` | +3 null fields to estimate fixtures |
| `backend/src/__tests__/estimates.test.ts` | +~14 tests (approve + getPublic) |
| `frontend/src/pages/PublicEstimatePage.tsx` | Terms card, signature pad, updated handleAction, post-approval display |
| `frontend/src/pages/EstimateDetailPage.tsx` | Signature display in Details tab |
