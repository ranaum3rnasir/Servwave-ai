# Per-module gap ledgers

One file per module: `<module>-missing-components.md`. These are the working files.
They are folded into `UI_KIT_MISSING_COMPONENTS.md` at the repo root, which is what the user reads.

## When to write a row

While rebuilding a module you work through every `@/components/...` import its pages use. For each:

- the kit has an equivalent -> use it, no row
- the kit has nothing -> **use the old component**, do not build a replacement, write a row

Do not stop, do not improvise a kit version, and do not leave the feature out. A missing component
is a reporting task, not a blocker.

## Format

```markdown
# <Module> - components with no kit equivalent

## Gaps

| Old component | Kind | Used in | What it does | Kit's nearest thing | Why it is not enough | Also hit by | Rec |
|---|---|---|---|---|---|---|---|
| `crm/LineItemsEditor` | component | EstimateFormPage, InvoiceFormPage | editable line items with totals | none | - | - | KEEP |
| `data/dataTable` `rowSelection` | kit API | InvoicesPage | lifts the selected ids out | the prop does not exist | internal state, no callback out | Customers, Estimates | BUILD |

## Replaced (the audit trail)

| Old component | Replaced by | Notes |
|---|---|---|
| `data/ResizableTable` | `ui-kit/components/data/dataTable` | column sizing carried over |

## Behaviour not reproduced

Anything the legacy page did that the v2 page does not. Write `None.` if there is nothing -
an empty section and a missing section read the same, and only one of them is a claim.

| What the legacy page did | What v2 does instead | Why it could not be carried over |
|---|---|---|

## Observed but not fixed

Bugs noticed while working that are NOT part of this migration. Logged, never fixed here.

| What | Where | Why it is out of scope |
|---|---|---|
```

`Rec` is one of **BUILD** (generic, many callers, worth adding to the kit), **KEEP** (specific,
one caller, leave it), **DROP** (v2 does not need it; goes at cutover).

### The three fields Wave A added

**`Kind`** is `component` or `kit API`. Wave A produced two gaps of the second sort - `DataTable`
holds `columnVisibility`, `rowSelection` and `sorting` in internal state with no prop in or out, and
`form/formField` throws outside a react-hook-form context. Both are the right component with the
wrong surface, and mixing them into a list of things the kit does not have hides them. A `kit API`
row names the prop it wants.

**`Also hit by`** is how the roll-up ranks. The roll-up's ranked BUILD list is the argument for
building anything, and that number cannot be reconstructed after the fact: three modules that each
worked around `rowSelection` a different way filed one BUILD row, one shape-difference row and one
observation between them. Before filing a BUILD row, read section 1 of
`UI_KIT_MISSING_COMPONENTS.md`. If the item is already there, say so in this column and keep your
row - the duplicate row is the evidence, not noise.

**`Behaviour not reproduced`** exists because Wave A had nowhere to put one. The kit's `DataTable`
has no `tableKey`, so the per-user saved column layout is gone from every rebuilt list. One ledger
recorded it inside a gap row with `Rec: BUILD`, which is wrong twice over - it is a loss, not a
missing component, and nothing gets built to restore it except the props above. Another ledger
asserted its module never had the feature, which the code contradicts. A required section with an
explicit `None.` would have caught both.

### Classify the same fact the same way

`filterPopover`, `appliedFilters` and `statusChip` are duplicated across modules on purpose, because
the parallel-branch rule forbids a shared location. That duplication is **not** a gap row and
**not** an observation: it goes under `## Shape differences forced by the kit` with the file paths of
every copy you made. The roll-up keeps the consolidation work list.

## The "Replaced" table is not optional

It is how "every component was replaced" is *audited* rather than asserted. A module whose
replaced-table is shorter than its import list has unfinished work, and that has to be visible
without re-reading the diff.
