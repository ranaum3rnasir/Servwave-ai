# Attachment bucket ceiling vs the app cap — probe transcript

**Slice:** direct-to-storage uploads, S4 (raise the caps) · **Captured:** 2026-09-19 ·
**Re-measured:** 2026-09-20

> **SUPERSEDED BY THE 2026-09-20 SECTION AT THE TOP.** Everything from "## The rule being
> checked" down is the 2026-09-19 transcript, left standing verbatim. Two of its load-bearing
> facts are no longer true: production's bucket was 64 MiB and is now 512 MiB, and the rule it
> describes ("strictly above") was reversed on 2026-09-20 after the storage ceiling was measured
> and found to be INCLUSIVE. A probe transcript is a record of what was true when; it is
> annotated rather than edited.

## 2026-09-20 — what is true now

### Both projects' buckets, read from `storage.buckets`

```
captured: 2026-09-20  via storage.buckets, both projects

== staging (knriiqdqxgfoecsfarlx) ==
select id, file_size_limit from storage.buckets order by id;

  attachments         536870912      (512 MiB)
  call-recordings     null           (unlimited)
  org-assets          null           (unlimited)
  price-book-images     2097152      (2 MiB)
  qa-screenshots       10485760      (10 MiB)

== production (fvcjinnllchzqcupmrah) ==
select id, file_size_limit from storage.buckets order by id;

  attachments         536870912      (512 MiB)     <- was 67,108,864 on 2026-09-19
  call-recordings     null           (unlimited)
  org-assets          null           (unlimited)
  price-book-images   null           (unlimited)
```

**Project-level global file size limit: 1 GB on both projects** (Ran raised both, 2026-09-20).
Attributed rather than measured here: the global lives in the storage platform's own settings
and is not in `storage.buckets`, so no SQL in this file can read it. It supersedes the
second-hand "project-level 50 MiB" note at the bottom of the 2026-09-19 transcript, which was
labelled as unconfirmed at the time and is now known to be wrong.

| project | bucket ceiling | app cap | project global | bucket ≥ cap? |
|---|---|---|---|---|
| staging | 536,870,912 | 536,870,912 | 1 GB | **yes**, exactly |
| production | 536,870,912 | 536,870,912 | 1 GB | **yes**, exactly |

**Production passes now.** The 2026-09-19 conclusion — "this change must not reach production
until the bucket is raised" — is discharged: Ran raised it.

### The rule changed, because its premise was measured and was false

`verify-attachment-bucket.ts` required the bucket ceiling to sit **strictly above** the app
cap. The stated reason was that a file at exactly the app limit "lands on the bucket's own
boundary, and whichever gate answers first decides what the user is told".

Measured against staging's live bucket on 2026-09-20 with a resumable-upload creation POST:

```
Upload-Length: 536870912  (exactly 512 MiB)  -> HTTP 201 Created   (then DELETE -> 204)
Upload-Length: 536870913  (one byte more)    -> HTTP 413 "Maximum size exceeded"
```

The storage ceiling is **inclusive**. At equality the bucket does not fire, so a file at
exactly the app cap is accepted by storage and our own 400 stays the only gate that can refuse
at the boundary — which is what the strict rule was trying to buy. The rule is now
`limit < MAX_VIDEO_FILE_SIZE`: the bucket must be **at least** the app cap.

Equality is the shipped configuration on purpose — `MAX_VIDEO_FILE_SIZE` is pinned to the
bucket limit (536,870,912). A bucket **below** the app cap is still a genuine failure, because
then storage refuses with a 413 we neither raise nor phrase, after the user has paid for the
whole upload.

The unit test now pins that boundary with LITERAL bytes
(`backend/scripts/__tests__/verify-attachment-bucket.test.ts`). Every fixture there derives
from `MAX_VIDEO_FILE_SIZE`, which is why the suite stayed green while the real invariant broke:
derived fixtures re-assert whatever the rule currently says against whatever the constant
currently is, so the constant and the rule can drift together untouched.

---

## The 2026-09-19 transcript (historical)

Why this file exists: S4 raises the app's video cap to 500MB, and the storage bucket has a
ceiling of its own that no code can see. `backend/scripts/verify-attachment-bucket.ts` is the
only thing that compares them, and until this slice it answered a mismatch with `console.warn`
and exit 0 — so a green run proved nothing about the size at all. The numbers below are what
the two projects actually held at the moment S4 was written, read from `storage.buckets` rather
than from a dashboard screenshot or from memory.

## The rule being checked

<!-- SUPERSEDED 2026-09-20: the rule is now "at least", and the premise below was measured
     to be false — the storage ceiling is inclusive. See the section at the top. -->

`verify-attachment-bucket.ts` requires the bucket ceiling to sit **strictly above** the app
cap, not merely at it. A file at exactly the app limit would otherwise land on the bucket's own
boundary, and whichever gate answers first decides what the user is told. The app's sentence is
the one we wrote and the one that names a limit the user can act on, so it has to be the one
that fires.

App cap after S4: `MAX_VIDEO_FILE_SIZE` = 500 MB = **524,288,000 bytes**.
<!-- SUPERSEDED 2026-09-20: the app cap is 512MB = 536,870,912 bytes, pinned to the bucket. -->

## Transcript

```
captured: 2026-09-19  via storage.buckets, both projects

== staging (knriiqdqxgfoecsfarlx) ==
select id, file_size_limit from storage.buckets;

  attachments         536870912      (512 MiB)
  call-recordings     null           (unlimited)
  org-assets          null           (unlimited)
  price-book-images     2097152      (2 MiB)
  qa-screenshots       10485760      (10 MiB)

== production (fvcjinnllchzqcupmrah) ==
select id, file_size_limit from storage.buckets where id = 'attachments';

  attachments          67108864      (64 MiB)
```

## What this establishes

| project | ceiling | app cap | strictly above? |
|---|---|---|---|
| staging | 536,870,912 | 524,288,000 | **yes**, by 12,582,912 bytes |
| production | 67,108,864 | 524,288,000 | **NO** — the bucket is 7.8x smaller than the cap |

**Staging passes.** The 64 MiB figure the slice was written against is stale for staging: the
ceiling was raised to 512 MiB by the separate agent doing that work, and 512 MiB (binary)
happens to clear 500 MB (decimal) with room to spare. That coincidence is worth naming rather
than relying on — the two numbers are close, they are in different units, and the check is a
strict inequality. It holds, but not by much.

**Production does NOT pass and this change must not reach it until it does.**
<!-- SUPERSEDED 2026-09-20: production's attachments bucket is now 536,870,912. --> A 300MB clip on
production today would be accepted by every app-side gate, pushed the whole way by the browser,
and refused at the end by storage with a message we neither wrote nor control. That is strictly
worse than the 50MB refusal it replaces, because the user pays the upload first.

## What this does NOT establish

- **No upload was performed.** These are configuration reads. Nothing here shows that a 500MB
  object actually lands, only that the bucket ceiling would not be the thing to stop it.
- **The project-level global file size limit was not read, and it is the binding one.** A
  bucket limit cannot exceed the project-level global, so a bucket value that clears the app
  cap is necessary and **not sufficient**. No code in this repo can read that number, which
  means `verify-attachment-bucket.ts` cannot either — it now prints that caveat on every pass
  rather than letting a green run be read as "500MB uploads work now". Production's global is
  unknown from here, and raising production's bucket may require raising the global first.
  Whoever does it should read the value rather than assume.
- **`allowed_mime_types` was only checked for null-ness**, not compared type by type. That is
  what `npm run verify:attachment-bucket --workspace=backend` does against a live project, and
  it is the command to run before promoting, not this transcript.

### Second-hand, and labelled as such

<!-- SUPERSEDED 2026-09-20: the project-level global is 1 GB on both projects. The 50 MiB
     figure below was labelled unconfirmed and turned out to be wrong. -->

Not measured by this work. Recorded because it changes what the table above means, and would
otherwise have to be rediscovered: the reviewer of this slice reports the binding constraint is
a **project-level 50 MiB limit** that a bucket cannot override. If that holds, staging's 512
MiB bucket value does not by itself make a 500MB upload land, and the "staging passes" row
above should be read strictly as what it says — the bucket is not the narrowest gate — rather
than as end-to-end readiness. Attributed rather than absorbed into the first-person record, and
worth confirming against the storage settings before anyone promotes on the strength of it.

## Footnote: `tsc -p tsconfig.build.json` needs `prisma generate` first

This will cost someone an afternoon otherwise. On a fresh `npm ci` the backend build type-check
exits **2** with **889 errors**, of the form `Module '@prisma/client' has no exported member
'AttachmentEntity'` (the member named depends on which file is reported first — the reviewer
saw `'Role'`). The generated client does not exist yet, so every Prisma type resolves to
nothing and the failure reads like a broken branch rather than a missing build step.

Measured both ways on this branch: **889 errors / exit 2** with no generated client, **0 errors
/ exit 0** immediately after `prisma generate`, nothing else changed.

```
npm ci                       # at the WORKTREE ROOT. This is an npm workspaces repo: running
                             # npm ci in backend/ and frontend/ concurrently makes them race
                             # over the shared root node_modules and BOTH die (ENOTEMPTY).
npx prisma generate --schema backend/prisma/schema.prisma
cd backend && npx tsc -p tsconfig.build.json --noEmit    # 0
```

`tsc --noEmit` (the non-build config, which also covers the test tree) exits **2** on this
branch with 17 pre-existing errors across 9 files, every one of them byte-identical to
`origin/staging`. That is the baseline, not a regression.
