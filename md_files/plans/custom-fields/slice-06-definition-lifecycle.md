# Slice 6 - Definition lifecycle: reorder, archive, required

**Parent:** SRVW-114 · **Type:** AFK · **Blocked by:** Slice 2

## What to build

Turn on the three definition columns that slice 1 landed inert, and close out the MVP.

**`sort_order`** - admin reorders fields; the panel and the item dialog render in that order
everywhere. Without this, field order is whatever the database returns, which is not a defensible
answer for a panel an org sees a hundred times a day.

**`archived_at`** - archive is the only removal. An archived definition disappears from every panel
and from the definition picker, rejects new writes, and leaves stored values untouched on every
record. Unarchiving brings the field and its historical values back intact. There is no hard delete
in the UI or the API.

**`required`** - enforced **in the panel**, not as an API 400. The panel blocks its own save and marks
the field; the shared PATCH endpoints stay permissive.

The reason is structural, and it is the one design call worth re-reading: values ride the entities'
existing PATCH endpoints, which serve dozens of unrelated partial updates. If `required` 400'd at
that layer, the moment an admin ticked "required" on a new field, every existing lead, job and
customer in the org would become unpatchable until someone backfilled it - a status change, a
reschedule, a note edit, all failing on an unrelated empty field. A hard API gate is buildable but
needs its own submit endpoint, and that is a separate decision, recorded here rather than smuggled in.

## Acceptance criteria

- [ ] Admin can reorder definitions; the order is respected in the Extra Info panel and the item dialog
- [ ] Archiving a definition removes it from every panel and picker, and rejects new writes for it
- [ ] Archiving preserves stored values on every record; unarchiving restores the field with values intact
- [ ] No hard-delete path exists for a definition in the API or UI
- [ ] A required field with no value blocks the panel's own save and is visibly marked
- [ ] Marking an existing field required does NOT break unrelated PATCHes on records missing that value, proven by an explicit test
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Notes

Completing this slice closes every SRVW-114 acceptance criterion. Before starting any SRVW-115 slice,
confirm with Ran that the MVP has proven the schema model, which is the precondition the v2 card
itself states.

## Blocked by

- Slice 2 (all field types exist to order, archive and require)
