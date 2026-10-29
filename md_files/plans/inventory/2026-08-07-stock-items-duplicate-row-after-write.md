# Plan - Stock Items: transient duplicate row after a create/edit

**Date:** 2026-08-07
**Module:** Inventory (Stock > Items)
**Status:** reproduced on staging, fix applied - pending live re-verification after deploy
**Found:** during the live staging verification of PR #1382 (model/part number)

## Symptom

Immediately after saving a new item from Stock > Items, the row renders **twice** and
the counters inflate: the Items tab badge went 14 -> 16 and the grid footer read
"18 items of 18 total" when the org had 17. The same double-render appeared again after
an edit. A page reload always collapses it to exactly one row.

The database was never wrong. Verified during the PR #1382 E2E: `price_book_items` held
exactly one row for the probe SKU at every point, and the per-org count matched the
correct number both before and after. **This is a render/state defect, not data loss** -
but it reads as data corruption to anyone watching, which is why it is worth fixing.

## Mechanism (hypothesis - step 1 must confirm it)

`InventoryPage` keeps a local mirror of the server list and seeds it from the query:

- `frontend/src/pages/inventory/InventoryPage.tsx:209` - `const [allItems, setAllItems] = useState<Item[]>([])`
- `InventoryPage.tsx:216-218` - effect: `if (itemsQuery.data) setAllItems(itemsQuery.data)` (full replace)
- `InventoryPage.tsx:475` - create path: `setAllItems((prev) => [newItem, ...prev])` (optimistic prepend)
- `frontend/src/lib/api/inventory.ts:619` - `useUpsertItem` `onSuccess` -> `invalidateQueries(['inventory'])`

The intended order is: mutation resolves -> optimistic prepend -> refetch resolves ->
effect replaces the whole array with server truth (one row). That self-heals.

The suspected failure is a **race in the opposite order**: `invalidateQueries` fires inside
`onSuccess`, which runs *before* `await mutateAsync` resolves in `handleSave`. If the refetch
resolves before the code reaches line 475, the effect has already replaced `allItems` with the
server list that **already contains the new item** - and then line 475 prepends a second copy
on top. Nothing replaces the array again until the next invalidation or a reload, so the
duplicate persists for as long as the page sits idle.

This also explains why it recurs after an edit and why a reload always fixes it.

**Confidence: medium.** The ordering above is inferred from reading the code, not observed.
Do not skip step 1.

### Why `key={item.id}` does not save us

The row key is `item.id` (`InventoryPage.tsx:1111`) and the optimistic row now carries the real
server id (`created.id`), so both copies share a key. React tolerates duplicate keys with a
console warning rather than crashing - which is why nothing errored during the E2E. If the
repro in step 1 shows a duplicate-key warning, that confirms the mechanism outright.

## Outcome (2026-08-07)

Reproduced live on staging, fix applied. The mechanism below was right in substance;
the correction is that it is driven by **React batching**, not by promise-resolution order.

**Live repro** (`servwave-demo.vercel.app`, ServWave Test org, 16 items):
create one item, XHR/fetch instrumented. Result: **exactly one POST** to
`/api/price-book/items`, and the probe SKU rendered at **row 1 and row 18**, footer
"18 items · of 18 total". After a reload: 17 rows, one probe row. The DB always held one
row. Probe deleted afterwards; org back to 16.

So it is not a double submit (one POST) and not a filter defect - the extra row is in
`allItems`, put there by the optimistic prepend.

**Corrected mechanism.** It is not that the refetch *resolves* before line 475 - a network
macrotask genuinely cannot land between two microtasks, and a unit test with real
`useInventoryItems` confirms the plain ordering is safe. It is that React 18 **batches**
the seed effect's `setAllItems(serverList)` with the handler's
`setAllItems(prev => [newItem, ...prev])` and applies them in enqueue order: the replace
lands first, then the prepend stacks a second copy onto a list that already contains the
item. Nothing re-seeds `allItems` afterwards, so it persists until a reload.

**No duplicate-key warning appeared, and none ever would** - staging serves a production
React build, which does not emit them. That signal was never available; disregard the
step-1 note below that treats it as confirmation.

**Test coverage is honest but partial.** `inventory-duplicate-row-after-create.test.tsx`
was run against the buggy code with the prepend restored and **still passed** - under
jsdom + act React will not flush the seed effect mid-await, so the two updates never share
a batch however the mocked promises are ordered. The test pins the ordinary create path
(new SKU renders once, counter matches the server list) but does not pin this bug. The fix
must be re-verified on staging after deploy.

## Step 1 result (superseded by the live repro above)

`frontend/src/__tests__/inventory-duplicate-row-after-create.test.tsx` renders the real
`useInventoryItems` query (only the unrelated read hooks are mocked) over a mutable server
list that the mocked POST appends to, then creates an item and asserts the SKU appears once.

**It passes on unmodified code.** No duplicate row, no duplicate-key warning, counter correct.

Reading the code again against that result, the race cannot happen as described:

- `invalidateQueries` starts the refetch, which is a network round trip - a macrotask.
- Line 475 runs on the microtask immediately after `mutateAsync` resolves.

A macrotask can never land between two microtasks, so the prepend **always** wins and the
refetch **always** replaces the whole array afterwards. There is no ordering in which the
effect seeds the server list before line 475 prepends. Re-checked the create path for an
intervening `await` between the mutation and the prepend (`InventoryPage.tsx:405-475`):
there is none.

`useInventoryFilters` was also cleared - it is a pure `.filter()` chain and cannot duplicate
a row, so the extra row must have been in `allItems`, and nothing in this path can put it there.

**What this does not explain:** the live symptom was real (counters inflated, a reload fixed
it). The cause is elsewhere and is not yet identified. Removing the prepend on this evidence
would be a speculative change that trades a real (if small) latency regression for a defect
this repo cannot currently demonstrate.

**Next step is a live re-check, not a code change:** create a probe item on staging with the
console open, and record whether the row actually renders twice and whether React logs a
duplicate-key warning. Rewrite this plan from what that shows. The regression test above is
worth keeping either way - it pins "a created item renders once" against the real query seam.

## Fix (APPLIED)

**Preferred: delete the optimistic prepend.** The invalidation already re-seeds `allItems`
from the server, so the local row buys nothing but the race.

There is direct precedent in the same file - the CSV import path deliberately builds no mirror
for exactly this reason (`InventoryPage.tsx:636`):

> the `['inventory']` invalidation re-seeds allItems from the server, so there is no local
> mirror to build here.

Doing the same on the single-item create path makes the two write paths consistent.

Cost: the new row appears when the refetch lands instead of instantly. On a list capped at
`limit=100` (`inventory.ts:317`) that is one fast request, and the dialog already stays open
until the save resolves, so there is no perceived regression.

**Fallback if step 1 shows the delay is objectionable:** keep the prepend but dedupe by id -
`setAllItems((prev) => [newItem, ...prev.filter((i) => i.id !== newItem.id)])`. This is
strictly worse (it keeps a mirror that can drift on every other field) and should only be
taken if the plain removal is shown to hurt.

**Out of scope:** the edit path's mirror update (`InventoryPage.tsx:417`) and the whole
`allItems`-as-local-mirror pattern. Both are pre-existing and much larger; this plan fixes the
one visible defect, it does not refactor the page's state model.

## Steps

1. **Reproduce in a test first** (backend rules mandate TDD; this is frontend but the same
   discipline applies to a bug fix). Add to `frontend/src/__tests__/inventory-stock-page-writes.test.tsx`:
   resolve the upsert mutation and let the refetch land *before* the handler continues, then
   assert the saved SKU appears exactly once (`getAllByText(sku)` has length 1). Confirm it
   fails, and note whether React logs a duplicate-key warning.
2. Remove the prepend at `InventoryPage.tsx:475`; keep every downstream write that follows it
   (`setThresholds`, `setQuantity`) untouched - they key off `created.id`, not the mirror.
3. Re-run the test from step 1; it should pass.
4. Run the existing inventory suites, which exercise the create path and its toasts:
   `inventory-stock-page-writes`, `inventory-hybrid-delete`, `inventory-thresholds`,
   `price-book-persistence`, `inventory-model-part-number`.
5. `npx tsc --noEmit` + full frontend suite.
6. Live re-check on staging after merge: create an item, confirm one row and a correct count
   with no reload, then delete the probe row.

## Files

| File | Change |
|---|---|
| `frontend/src/pages/inventory/InventoryPage.tsx` | remove the optimistic prepend (line ~475) |
| `frontend/src/__tests__/inventory-stock-page-writes.test.tsx` | new failing-first regression test |

## Risk

Low. One line removed on one write path, with an existing precedent in the same file and a
regression test pinning the behaviour. The visible change is that a new row appears on refetch
rather than instantly.
