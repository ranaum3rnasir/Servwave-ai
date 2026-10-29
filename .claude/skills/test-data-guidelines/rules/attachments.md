# Attachment Test Data Rules

Polymorphic file attachment system using Supabase Storage. Attachments can be linked to any supported entity type with role-based access control.

## 0. Test Asset Files & E2E Infrastructure

### File Locations

Test fixture files for attachment uploads:

```
frontend/e2e/fixtures/
├── test-photo.jpg       (532 bytes — 1x1 red JPEG)
├── test-image.png       (70 bytes — 1x1 blue PNG)
└── test-document.pdf    (316 bytes — blank single-page PDF)
```

These are minimal valid files for testing the upload pipeline. They are NOT realistic photos/documents — they exist only to exercise the upload, storage, and retrieval flow.

### E2E Helpers

| Helper | Location | Purpose |
|--------|----------|---------|
| `ApiClient.uploadAttachment()` | `frontend/e2e/helpers/api-client.ts` | Multipart upload to `/api/attachments/:entityType/:entityId` |
| `ApiClient.listAttachments()` | `frontend/e2e/helpers/api-client.ts` | List attachments for an entity |
| `ApiClient.deleteAttachment()` | `frontend/e2e/helpers/api-client.ts` | Delete a single attachment |
| `ATTACHMENT_POOL` | `frontend/e2e/helpers/test-data.ts` | 10 realistic metadata entries (display_name, description, context) |
| `pickRandomAttachments()` | `frontend/e2e/helpers/test-data.ts` | Pick 1-3 random entries from the pool |
| `attachTestFiles()` | `frontend/e2e/helpers/workflow-builders.ts` | Upload random attachments to any entity in one call |

### Usage in Workflow Tests

```typescript
import { attachTestFiles } from '../helpers/workflow-builders';

// Attach 2 random files to a job
const attachments = await attachTestFiles(api, 'JOB', jobId, 2);

// Or let it pick 1-3 randomly
const attachments = await attachTestFiles(api, 'LEAD', leadId);
```

---

---

## 1. Supported Entity Types

| Entity Type | Enum Value | Typical Attachments |
|------------|-----------|---------------------|
| Lead | `LEAD` | Site photos from initial contact, property condition |
| Estimate | `ESTIMATE` | Scope documentation, existing equipment photos |
| Job | `JOB` | Before/after photos, work documentation, permits |
| Invoice | `INVOICE` | Receipts, signed documents, lien waivers |

---

## 2. Attachment Context Types

| Context | Display Name | Use Case |
|---------|-------------|----------|
| `WALKTHROUGH` | "Site Visit" | Walkthrough/inspection photos and documentation |
| `JOB_WORK` | "Job Documentation" | Photos and files from job execution |
| `ESTIMATE` | "Estimate" | Estimate-related supporting files |
| `OTHER` | "Other" | Default — miscellaneous files |

Default context is `OTHER` if not specified or invalid.

---

## 3. File Constraints

| Constraint | Value | Source |
|-----------|-------|--------|
| Max single file size | **25 MB** | `attachment.controller.ts:16`, `attachment.routes.ts:10` |
| Max total per entity | **200 MB** | `attachment.controller.ts:17` |
| Allowed MIME types | `image/jpeg`, `image/png`, `image/heic`, `image/heif`, `video/mp4`, `video/quicktime`, `application/pdf` | `attachment.controller.ts:10-14` |
| User-facing format list | JPG, PNG, HEIC, MP4, PDF | Error messages and UI |

---

## 4. Required Fields

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `entity_type` | AttachmentEntity | Yes | One of: LEAD, ESTIMATE, JOB, INVOICE |
| `entity_id` | UUID | Yes | Must reference an existing entity |
| `file` | binary | Yes (upload) | Must be provided in multipart/form-data |
| `display_name` | string | Yes | 1-255 characters |
| `description` | string | Yes | Max 2000 characters (default empty string in schema) |
| `context` | AttachmentContext | No | Defaults to OTHER |
| `file_name` | string | Auto-set | Original filename from upload |
| `file_url` | string | Auto-set | Supabase Storage public URL |
| `file_type` | string | Auto-set | MIME type from upload |
| `file_size` | integer | Auto-set | File size in bytes |
| `uploaded_by` | UUID | Auto-set | Current authenticated user |

### Update Fields (PATCH)

| Field | Type | Constraints |
|-------|------|-------------|
| `display_name` | string | 1-255 characters, optional |
| `description` | string | Max 2000 characters, optional |

Only `display_name` and `description` can be updated. File, context, and entity cannot be changed after upload.

---

## 5. Storage Path Pattern

Files are stored in Supabase Storage bucket `attachments` with path:

```
{entityType}/{entityId}/{timestamp}-{filename}
```

Example: `JOB/j0000000-0000-0000-0000-000000000001/1711900800000-before-photo.jpg`

---

## 6. Role-Based Access Control

| Role | LEAD | ESTIMATE | JOB | INVOICE |
|------|:----:|:--------:|:---:|:-------:|
| ADMIN | Full | Full | Full | Full |
| DISPATCHER | Full | Full | Full | Full |
| SALES | Own leads + performer | Own lead's estimates | None | None |
| TECHNICIAN | Performer only | None | Assigned + performer | None |

**SALES access details:**
- LEAD: `assigned_to === userId` OR `walkthrough_assigned_to === userId`
- ESTIMATE: estimate's lead `assigned_to === userId`
- JOB, INVOICE: no access

**TECHNICIAN access details:**
- JOB: `assigned_to === userId` OR `walkthrough_assigned_to === userId`
- LEAD: `walkthrough_assigned_to === userId` only
- ESTIMATE, INVOICE: no access

---

## 7. Timeline Events

All attachment operations create timeline events on the parent entity:

| Operation | Event Type | Metadata |
|-----------|-----------|----------|
| Upload | `ATTACHMENT_UPLOADED` | `{ attachment_id, file_type, context }` |
| Update | `ATTACHMENT_UPDATED` | `{ attachment_id }` |
| Delete | `ATTACHMENT_DELETED` | `{ attachment_id, file_name }` |

---

## 8. Valid Test Data Examples

**Job work documentation (by TECHNICIAN):**
```
{ entity_type: "JOB", entity_id: job_id,
  file: <25MB JPEG>, display_name: "Compressor before replacement",
  description: "Existing Trane XR15 compressor — visible corrosion on service valve",
  context: "JOB_WORK" }
```

**Walkthrough site photo (by TECHNICIAN on lead):**
```
{ entity_type: "LEAD", entity_id: lead_id,
  file: <5MB PNG>, display_name: "Electrical panel overview",
  description: "Main panel — 100A Square D, 30 of 40 slots used",
  context: "WALKTHROUGH" }
```

**Invoice receipt (by ADMIN):**
```
{ entity_type: "INVOICE", entity_id: invoice_id,
  file: <2MB PDF>, display_name: "Payment receipt #4892",
  description: "Check scan for payment received 2026-02-15",
  context: "OTHER" }
```

**Estimate scope photo (by SALES):**
```
{ entity_type: "ESTIMATE", entity_id: estimate_id,
  file: <8MB JPEG>, display_name: "Ductwork condition — attic",
  description: "Two separation points at joints, needs sealing before install",
  context: "ESTIMATE" }
```

---

## 9. Invalid Data for Testing

| # | Violation | Description | Expected Result |
|---|-----------|------------|-----------------|
| A-01 | Missing file in upload | No file in multipart/form-data | 400 "No file provided" |
| A-02 | Invalid file type | Upload a .exe or .zip file | 400 "File type not allowed" |
| A-03 | File exceeds 25 MB | Upload a 30 MB video | 400 "File too large" |
| A-04 | Entity total exceeds 200 MB | Cumulative uploads > 200 MB on one entity | 400 "would exceed 200MB limit" |
| A-05 | Invalid entity_type | `entity_type: "CUSTOMER"` | 400 "Invalid entity type" |
| A-06 | Non-existent entity_id | Valid UUID but no matching entity | 404 "Entity not found" |
| A-07 | Missing display_name | Upload without display_name field | 400 "display_name is required" |
| A-08 | Missing description | Upload without description field | 400 "description is required" |
| A-09 | SALES accessing JOB attachment | SALES role, JOB entity | 403 "Insufficient permissions" |
| A-10 | SALES accessing other rep's lead | Not assigned_to and not walkthrough performer | 403 "Insufficient permissions" |
| A-11 | TECHNICIAN accessing ESTIMATE attachment | TECHNICIAN role, ESTIMATE entity | 403 "Insufficient permissions" |
| A-12 | TECHNICIAN accessing INVOICE attachment | TECHNICIAN role, INVOICE entity | 403 "Insufficient permissions" |
| A-13 | TECHNICIAN accessing unassigned job | Not assigned_to and not walkthrough performer | 403 "Insufficient permissions" |
| A-14 | display_name > 255 chars | Exceeds max length | Should fail validation |
| A-15 | description > 2000 chars | Exceeds max length | Should fail validation |
| A-16 | Empty display_name | display_name: "" | Should fail validation |
