# Runbook — attachment orphan sweep

**Tool:** `npm run sweep:attachment-orphans --workspace=backend`
**Code:** `backend/scripts/attachment-orphan-sweep.ts` (CLI) · `backend/src/lib/attachment-orphan-sweep.ts` (logic, and where the safety argument is written down)
**Slice:** direct-to-storage uploads, S3.

This deletes objects from a production bucket. There is no restore. Dry-run is the default and
every step below is a dry-run until the last one.

## What it is for

The direct upload path lets a client send bytes and then never record them — closed tab, lost
signal, or our own post-upload verification failing, in which case we deliberately leave the
object rather than destroy someone's upload over our outage. Those objects are invisible to the
app and billed forever. `deleteAttachment` also logs and continues when a storage delete fails,
which has been producing orphans since long before the direct path existed.

## Who runs it, and how often

Nothing schedules this and nothing should: there is no cron service, no worker, no queue, and
the only in-process scheduler runs on an instance that spins down when idle. It is operator-run,
by whoever owns a release — **quarterly**, and additionally **before any change that raises the
upload caps** (S4), which is the case the PRD gates on S3 for.

A quarterly cadence is comfortable because the grace window is 7 days and the bucket is small;
the cost of waiting is storage, the cost of being early is a customer's file.

## Reading a dry-run

Counts first, then detail, then a `SUMMARY` block — read the summary first.

- **`ORPHANS`** — what would be deleted.
- **`other subsystems`** — objects belonging to profile photos, inventory assets, job-stage
  photos, email attachments, estimate scope photos and version snapshots. Never touched. A
  non-zero count here is normal and healthy.
- **`unrecognised`** — a path shape the sweep does not know. Never touched. A sudden rise means
  a new writer appeared and the allowlist may need looking at.
- **`row(s) point at a host that is not our storage`** — printed **by host**. Third-party hosts
  (seed/demo data) are expected. **A host that looks like our own storage product at a different
  project ref means a migration happened and those rows protect nothing — stop and investigate.**
  (A URL carrying our bucket's own public path shape on another host is refused outright, so it
  cannot reach this line silently.)
- **`orgless prefixes skipped`** — storage prefixes with no `Organization` row. Skipped by
  default because every per-org guard is inert on them. Sweep one deliberately with
  `--org=<prefix>` after confirming the org really was deleted.

## Prod sequence

Do these in order. Do not skip to step 4.

**1. Census — before running the tool at all.**

Confirm that every legacy row (`storage_path` NULL or empty) resolves to a key in *this*
bucket. Production is where pre-migration rows live: staging has none that point at our own
storage, and the cutover clone has no legacy rows at all, so this path has never met real data.

The census must classify on the **same two axes the code does** — *is the URL host ours* x *does
its path carry our bucket's public-object shape* — because a single "is it parseable" test is
blind to the one case that matters. A row on **another** host carrying **our** path shape is a
project migration: it looks perfectly fine to a naive check and is exactly what the tool
refuses. Set `our_host` to the host in `SUPABASE_URL` for the environment you are about to
sweep.

```sql
WITH cfg(our_host, bucket) AS (VALUES ('<ref>.supabase.co', 'attachments')),
r AS (
  SELECT a.id,
         coalesce(a.storage_path,'') <> '' AS has_path,
         coalesce(a.file_url,'')            AS url,
         -- `(?:[^/?#@]*@)?` strips userinfo, so `https://ours@evil.example/…` reports
         -- evil.example — the same host the URL parser in the code resolves.
         -- `[a-zA-Z]+` because URL schemes are case-insensitive and `HTTPS://` resolves in the
         -- code. The PATH regex below stays case-SENSITIVE on purpose: the code matches that
         -- segment with a literal string split, so `/STORAGE/v1/...` is not our shape there
         -- either, and a blanket case-insensitive match would disagree with it.
         substring(coalesce(a.file_url,'') from '^[a-zA-Z]+://(?:[^/?#@]*@)?([^/?#]+)') AS url_host,
         substring(coalesce(a.file_url,'') from '^[a-zA-Z]+://(?:[^/?#@]*@)?[^/?#]*([^?#]*)') AS url_path
  FROM attachments a
),
c AS (
  SELECT r.*, cfg.our_host, cfg.bucket,
         (r.url_path ~ ('/storage/v1/object/public/' || cfg.bucket || '/.+')) AS our_shape
  FROM r CROSS JOIN cfg
)
SELECT count(*) AS total,
       count(*) FILTER (WHERE has_path)                                               AS resolved_by_storage_path,
       count(*) FILTER (WHERE NOT has_path AND url_host = our_host AND our_shape)     AS resolved_legacy_ours,
       count(*) FILTER (WHERE NOT has_path AND url_host IS NOT NULL
                          AND url_host <> our_host AND NOT our_shape)                 AS harmless_external,
       count(*) FILTER (WHERE NOT has_path AND url_host IS NOT NULL
                          AND url_host <> our_host AND our_shape)                     AS refuses_migrated_host,
       count(*) FILTER (WHERE NOT has_path AND url_host = our_host AND NOT our_shape) AS refuses_ours_unparseable,
       count(*) FILTER (WHERE NOT has_path AND (url = '' OR url_host IS NULL))        AS refuses_no_url
FROM c;
```

How to read it:

| Column | Meaning | Action |
|---|---|---|
| `resolved_by_storage_path` + `resolved_legacy_ours` | Protected. Should equal the tool's `distinct object path(s)`. | — |
| `harmless_external` | Third-party URLs (seed/demo data). Name no object in this bucket. | None. Expected. |
| `refuses_migrated_host` | **Our path shape on another host — a project migration.** These rows protect nothing. | **STOP.** Investigate before running at all. |
| `refuses_ours_unparseable` | On our host, not a shape the parser understands (e.g. a signed URL). | Repair; the tool refuses their org. |
| `refuses_no_url` | Neither a path nor a URL. | Repair; the tool refuses their org. |

**The three `refuses_*` columns must be 0**, or the sweep will refuse those orgs — which is the
tool working, not a fault. `harmless_external` being non-zero is fine and says nothing about
safety.

Measured on staging, 2026-09-18 — consistent with the tool sweeping 13 of 13 orgs with no
refusal, and with its own banner (`1922 -> 1915 distinct object path(s)`, `7 row(s) point at a
host that is not our storage`):

```
 total | resolved_by_storage_path | resolved_legacy_ours | harmless_external |
  1922 |                     1915 |                    0 | 7                 |
 refuses_migrated_host | refuses_ours_unparseable | refuses_no_url
                     0 |                        0 | 0
```

Note what that shows: staging has **7 rows with no `storage_path`**, and **zero legacy rows
pointing at our own storage**. Those are different statements, and only the second means the
legacy-protection path is untested here.

Also confirm the object total, so a short listing is visible later:

```sql
SELECT count(*) FROM storage.objects WHERE bucket_id = 'attachments';
```

**2. One org, dry-run.** Start with the largest real org.

```
npm run sweep:attachment-orphans --workspace=backend -- --org=<uuid>
```

Check: `objects listed` is plausible against step 1, `matched to a row` is close to it, and
`ORPHANS` is a small number you can explain.

**3. All orgs, dry-run.**

```
npm run sweep:attachment-orphans --workspace=backend -- --all-orgs
```

`objects listed` summed across orgs should equal the census total minus anything under skipped
orgless prefixes. If it is short, the listing truncated — do not proceed.

**4. Spot-check the candidates in SQL.** Do not trust the tool's own answer for the first armed
run. For each path it would delete:

```sql
SELECT count(*) FROM attachments WHERE storage_path = '<path>';
-- Trailing % matters: a URL with a query string after the filename (?token=…, ?v=2) does NOT
-- end at the filename. Without it this returns 0 for a row that exists, and 0 here reads as
-- "safe to delete" — the one place a wrong query argues for destruction.
SELECT count(*) FROM attachments WHERE file_url LIKE '%' || '<filename>' || '%';
```

Both must be 0.

**5. Arm it, one org at a time.**

```
npm run sweep:attachment-orphans --workspace=backend -- --org=<uuid> --delete
```

The run writes `backend/tmp/attachment-orphan-sweep/<timestamp>.manifest.jsonl` with the exact
keys, before the first delete. **Keep it** — it is the only record. Diff it against the dry-run
output.

## Gate before prod

`--delete` has never been executed against real storage anywhere. The gate is an **armed staging
run** first, on candidates that have each been confirmed in SQL.

Note what staging does NOT prove: it has zero legacy rows pointing at our own storage, so an
armed staging run exercises the sweep but never the legacy-protection path. That path is first
exercised for real in production, which is why the census is step 1 and not optional.

## If it refuses

Refusals are the tool working. None is overridable by a flag, by design.

| Message | Meaning |
|---|---|
| `grace window ... below the floor` | `--min-age-hours` under 48. The floor is twice the resumable-upload window. Raise only. |
| `the database and the bucket belong to a different project` | `DATABASE_URL` and `SUPABASE_URL` are different environments. The protected set would come from one and be applied to the other. |
| `could not confirm that DATABASE_URL and SUPABASE_URL are the same project` | Only when armed. Unusual setup (local DB, custom domain). Dry-run still works. |
| `the protected set is empty` | The bucket has attachment-owned objects but no rows resolve. Almost always the wrong database or a read that was scoped away — not a bucket of garbage. |
| `points at attachments on a DIFFERENT host (X) — same storage layout, other project` | A legacy row naming our bucket's path shape at another project. It protects nothing, and its object is probably in this bucket. A migration happened, or `SUPABASE_URL` is wrong. Investigate before any run; do not repair the rows until you know which. |
| `N of its attachment row(s) have no storage_path and a file_url this sweep cannot turn into a key in THIS bucket` | Repair those rows first. Scoped to the one org, and the message names the reason per row. |
| `AttachmentEntity now claims ... another subsystem writes` | A schema change made another subsystem's objects deletable. Do not run until resolved. |
| `the cross-org bypass is not in effect` | The row read escaped `runUnscoped`; it would return zero rows under RLS. A code bug. |

## Known limit

The protected-set floor catches a **totally** empty set, not a partially short one: a read that
returned 40 of 1922 rows — right project, wrong filter — passes it and condemns the rest.
Closing that needs a plausibility band with a defensible threshold, which nothing currently
gives us. Until then the census above is the compensating control: compare its
`resolved_by_storage_path + resolved_legacy_ours` against the tool's reported
`distinct object path(s)`. **If those two numbers disagree, stop.**

## Output hygiene

`--all-orgs` prints real organization names. That is fine on a terminal, but this output is the
most likely thing to be pasted into a PR or an issue — which would put a real customer name in
the repo. Redact the names, or paste a single `--org=<uuid>` run.
