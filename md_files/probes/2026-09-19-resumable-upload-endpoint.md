# Resumable upload endpoint — probe transcripts

**Project:** `knriiqdqxgfoecsfarlx` (staging) · **Slice:** direct-to-storage uploads, S2

Why this file exists: every measurement behind
`frontend/src/lib/attachments/resumableTransport.ts` previously lived only as prose in
comments — which is exactly how an earlier "MEASURED" claim turned out not to be one. Prose
drifts from what was run. A transcript cannot.

Regenerate with `md_files/probes/resumable-upload-endpoint-probe.sh`. Nothing here writes to
storage: every request is rejected before any object is created, which is also why none of it
leaves residue for the orphan sweep.

## What these probes DO establish

- The signed route requires `x-signature` on **both** creation and transfer, and checks it
  **before resolving the upload** — the PATCH below uses an upload id that never existed and
  still answers with a header error rather than a not-found.
- `Upload-Metadata` is mandatory on creation.
- **The two routes are distinguishable from the error body alone**, which is the single most
  useful thing here. Both answer `400` and both say `Invalid Compact JWS`, so the *text* looks
  like a credential fault either way. Only the FORMAT discriminates: the signed route answers
  plain text, the unsigned route answers a JSON `AccessDenied` envelope. A JSON body means the
  request went to the wrong route, not that the token is wrong. Reading that backwards is what
  made the outage expensive.

## What they do NOT establish, and must not be read as establishing

Every request below is REJECTED. An error response can prove a negative — this request is not
acceptable — but never a positive. None of this shows that a well-formed presigned upload
succeeds.

- **The successful end-to-end run (`201` / `204` / `200`) was NOT captured here and was not
  run by this work.** It was performed by the reviewer with a token minted by our own API and
  reported back. It is trustworthy, but it is second-hand and is labelled as such rather than
  folded into the first-person record.
- **The 6MB chunk size remains a docs quotation.** It has never been independently confirmed,
  and the reported successful run does not record which chunk size produced it. The service
  advertises no `Tus-Max-Size` or `Tus-Extension` on `OPTIONS` (see below), so there is
  nothing to read it off from without a valid token. This is the last request-shape parameter
  still resting on documentation — the same class of parameter as the route that caused the
  outage.
- **The 24-hour upload-URL expiry** cannot be observed inside a session. Not binding for us:
  `RESUME_RECORD_MAX_AGE_MS` is 90 minutes against a 2-hour ticket.
- **The documented `409` on concurrent writers** was deliberately not probed: it needs a real
  created upload and would strand partial uploads that the orphan sweep cannot see.

## Transcript

```
captured: 2026-09-19T14:57:01Z  project: knriiqdqxgfoecsfarlx (staging)

== creation (POST) ==
--- signed route, valid Upload-Metadata, NO x-signature
    HTTP 400  body: Missing x-signature header
--- signed route, valid Upload-Metadata, malformed x-signature
    HTTP 400  body: Invalid Compact JWS
--- signed route, NO Upload-Metadata
    HTTP 400  body: Metadata header is required
--- UNSIGNED route, same presigned-shaped request
    HTTP 400  body: {"statusCode":"403","code":"AccessDenied","error":"Unauthorized","message":"Invalid Compact JWS"}

== transfer (PATCH) on an upload id that never existed ==
--- signed route, NO x-signature
    HTTP 400  body: Missing x-signature header
--- signed route, malformed x-signature
    HTTP 400  body: Invalid Compact JWS

== capability advertisement (OPTIONS) ==
--- signed route
    HTTP/2 200 
    allow: GET, HEAD, POST, OPTIONS
--- unsigned route
    HTTP/2 200 
    allow: GET, HEAD, POST, OPTIONS

== hostname ==
--- dig knriiqdqxgfoecsfarlx.storage.supabase.co
    172.64.155.33
    104.18.32.223
```

---

## Second-hand: the reviewer's live measurements

Not run by this work and not reproducible from here without a signed upload token. Recorded
because it is the only evidence that anything SUCCEEDS, and because the transcripts above can
only ever show what fails. Attributed rather than absorbed into the first-person record.

Source: live validation against the staging project, using the pinned `tus-js-client` version
and the option set lifted from `sendResumable`, issued from a real browser at the preview
origin.

### The transport works end to end

| step | result |
|---|---|
| `POST …/upload/resumable/sign` | `201` with `Location` |
| three `PATCH`es | `204`, offsets advancing |
| our `complete` (verify-and-record) | `201` |
| cancel → `DELETE` | `204`, and `storage.s3_multipart_uploads` back to the zero baseline taken first |

The cancel result is the one this work could not obtain for itself and had flagged as the
single biggest unverified risk: **the service does honour the termination**, so `abort(true)`
really does remove the partial rather than leaving residue the orphan sweep cannot see.

### Chunk size is NOT fixed at 6MB

The docs say the size "must be set to 6MB (for now)". Measured, non-final `PATCH`es:

| non-final chunk | status |
|---|---|
| 5 MiB | `204` |
| 6 MiB (what we ship) | `204` |
| 7 MiB | `204` |
| 6,000,000 (decimal) | `204` |

A complete transfer at `chunkSize: 5 MiB` also finished and verified (`complete` → `201`).
The real floor is most likely the S3 multipart minimum of 5 MiB, not a fixed 6. Our shipped
value works; the documented constraint was not reproducible.

### Transfer shape

- The chunk size on the wire is **6,291,456 bytes — 6 MiB binary**, not 6,000,000 decimal.
  The vendor's "6MB" is ambiguous between the two.
- The creation `POST` carries the first chunk.
- The final chunk is a smaller remainder (2 MiB on a 20 MiB file).
- The bodies sum to exactly the file size: no padding, no overlap.

### The route diagnostic, verified live

The plain-text-versus-JSON discrimination recorded above was confirmed across all three
cases. It is the load-bearing diagnostic in `resumableTransport.ts` and should be kept as
written.

## Still untested by anyone

- **The 24-hour upload-URL expiry.** Not observable inside a session; not binding for us
  (`RESUME_RECORD_MAX_AGE_MS` is 90 minutes against a 2-hour ticket).
- **The documented `409` on concurrent writers.**
- **The chunk-size bounds.** 5 MiB, 6 MiB, 7 MiB and 6,000,000 were accepted; nothing probed
  a sub-5 MiB non-final chunk, an upper bound, or the failure mode when one is refused.
- **The UI layer.** The preview app is unreachable because the staging backend's
  `CORS_ALLOWED_ORIGINS` is an exact-match list that does not include the preview origin, so
  the app bounces to login at `/api/auth/me`. The transport was exercised directly with our
  option set, and playback was checked in a bare `<video>` (readyState 4, 640x360, playhead
  advancing) rather than the app's player. **The transport is proven; the React layer above it
  is not.** That is an environment gap, not a defect in this branch, and it is the thing to
  watch first on staging after merge.
