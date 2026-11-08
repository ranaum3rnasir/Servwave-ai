export type Subject =
  | 'Dashboard' | 'Customer' | 'Lead' | 'Estimate' | 'Job'
  | 'Invoice' | 'User' | 'Department' | 'PriceBook' | 'Tag'
  // 'Pricing' (SRVW-140) is the catalog fast-follow promised in
  // md_files/plans/settings/2026-06-03-organization-settings-implementation-plan.md:34 and never
  // built. It is what `canSeePricing` keys on - cost, margin and money visibility - and it is
  // deliberately NOT 'Report', which gates only /api/reports and the Reports/Billing nav.
  | 'Report' | 'Pricing' | 'Organization' | 'StateTaxRate' | 'AppSetting'
  | 'Attachment' | 'Walkthrough' | 'Inventory' | 'PurchaseOrder' | 'Vendor' | 'LogisticOrder' | 'Communication'
  | 'Location' | 'Role' | 'ServicePlan' | 'Task' | 'Notification' | 'Timeclock'
  | 'Automation'
  // Calendar Entries (Slice 01, spec §4) - permission plumbing shipped BEFORE the
  // `calendar_entries` table exists (Slice 02), same move as 'renumber' above. Visibility is
  // org-wide (ADR 0002 / spec §4: no ownership chain, no own-scope) - never add this to
  // SCOPE_ENTITIES (roleViewModel.ts).
  | 'CalendarEntry'
  // Task categories (visits-and-task-categories slice 08). Every role reads; create/update/delete
  // are admin-only by having no default grant, the Tag rename/delete precedent. Setting a task's
  // category is part of `update Task` and needs nothing from this subject.
  | 'TaskCategory' | 'all';

export type Action =
  | 'manage' | 'create' | 'read' | 'update' | 'delete'
  | 'send' | 'cancel' | 'duplicate' | 'revise'
  | 'record_payment' | 'waive_deposit' | 'manage_lines'
  | 'void' | 'refund' | 'credit' | 'void_payment'
  | 'assign' | 'unassign' | 'en_route' | 'arrive' | 'start' | 'complete' | 'reopen' | 'reschedule'
  | 'export' | 'mark_lost' | 'contact' | 'schedule_walkthrough' | 'perform_walkthrough'
  // entity-redesign §10 lifecycle (Phase 3 minimal — broad CASL stays Phase 5)
  | 'archive' | 'force_purge' | 'anonymize'
  // Editable record IDs (2026-08-19 plan, decision #7). Permission plumbing only - the
  // PATCH .../:id/number endpoints this gates ship in a later PR. ADMIN gets it via the
  // manage-all bypass (no row needed); DISPATCHER holds it via an explicit DEFAULT_GRANTS row.
  | 'renumber'
  // Inventory P3 (D10/D13): per-user restriction flag — a per-user capability only
  // (userCapabilities.ts), never a role grant. See THE ACTUAL GATE note below.
  | 'location_restricted'
  // Logistic Orders (LO-1): `submit` + `process` ARE catalog entries (real role grants — SALES
  // submits, DISPATCHER processes). `approve` is deliberately absent FOR LogisticOrder — same
  // shape as location_restricted above: a per-user capability only (userCapabilities.ts), never a
  // role grant THERE. R4 (2026-07-21) reuses the same `approve` action string with a REAL role
  // grant on Estimate, gating `POST /:id/approve-internal` (shipped) and — later, same action —
  // the not-yet-built `POST /:id/approve-inperson` (port-plan `signinperson`/`dosign`). CASL keys
  // off the (action,subject) PAIR, so this does not reopen LogisticOrder's per-user-only gate.
  | 'submit' | 'approve' | 'process'
  // R4 (2026-07-21) — Estimate lifecycle verbs (port-plan §10.3/§5). `decline` mirrors `approve`'s
  // shape (internal, reason-required decline vs. the public route's optional one). `void_approval`
  // is D13's guarded unwind (WON → SENT) — ADMIN-only by design, no role grant exists for it.
  | 'decline' | 'void_approval'
  // Manual Communication Log (spec: md_files/specs/communication/2026-08-27-manual-communication-log.md).
  // "Record a communication that already happened, by hand." A NEW action on the EXISTING
  // Communication subject, and it has to be new: `create Communication` sits in SHARED_BASELINE
  // (defaultGrants.ts) and currently gates click-to-call, sending texts, WhatsApp and email, so a
  // role losing it would lose the ability to contact customers at all. Deliberately absent from
  // DEFAULT_GRANTS for SALES/DISPATCHER/TECHNICIAN - off by default for every existing org with no
  // migration; ADMIN holds it through the manage-all short-circuit. Making it grantable to other
  // roles is slice 4 (a sensitive-capability bundle, never an eleventh CRUD row).
  | 'log_past'
  // #2046 — the Communication SECTION gate (org-wide inbox, call log, phone settings), separate
  // from `read Communication` (the per-record tab a role reaches via the lead/job/customer
  // anchor). Same shape as `log_past`: a NEW action on the EXISTING `Communication` subject
  // rather than a new `Inbox` subject, because CASL keys off the (action, subject) pair and a new
  // subject would need its own plumbing across MODULES/ScopeResource/AppSubject for an entity
  // with no table and no rows to scope. A sensitive-bundle toggle, never an eleventh CRUD cell.
  | 'access_inbox';

// ─── THE GATE on the role-permission write path (read before trusting a comment here) ─────────
// There is exactly ONE write path into role_permissions from user input:
//   role.controller.ts putRolePermissions → viewModelToGrants(vm)  (roleViewModel.ts)
//
// PRIMARY gate — structural. putRolePermissions persists only what `viewModelToGrants` emits, and
// that function cannot emit anything outside:
//   MODULES × ACTION_BY_CELL ({read,create,update,delete})  +  the two SENSITIVE bundles
// ACTION_BY_CELL has no `approve` cell and no `location_restricted` cell, so neither reaches the
// DB — because the emitter cannot produce them, not because of any catalog check.
//
// SECONDARY gate — explicit. putRolePermissions additionally drops every emitted grant that fails
// `isCatalogEntry`, so an action deliberately kept out of PERMISSION_CATALOG cannot become a role
// grant even if someone later adds a matching cell to ACTION_BY_CELL. That filter is this helper's
// ONLY production caller — until 2026-07-20 it had none, and the comments here claimed it was the
// gate when it was not. Do not re-introduce that claim: verify with
//   grep -rn isCatalogEntry backend/src
// before describing this function as an enforcement point.
//
// TESTING: an invariant test for "X can never become a role grant" must drive viewModelToGrants /
// putRolePermissions (see permissions-logistic-orders.test.ts). A test that only asserts
// `isCatalogEntry(X) === false` is a placebo — it stays green after the real gate is removed.

export interface CatalogEntry {
  action: Action;
  subject: Subject;
  description: string;
  category: string;
}

export const PERMISSION_CATALOG: CatalogEntry[] = [
  // Dashboard
  { action: 'read',              subject: 'Dashboard',    description: 'View dashboard',                                    category: 'Dashboard'     },
  // Customer
  { action: 'create',            subject: 'Customer',     description: 'Create customers',                                  category: 'Customers'     },
  { action: 'read',              subject: 'Customer',     description: 'View customers',                                    category: 'Customers'     },
  { action: 'update',            subject: 'Customer',     description: 'Edit customers, locations, notes',                  category: 'Customers'     },
  { action: 'delete',            subject: 'Customer',     description: 'Delete customers',                                  category: 'Customers'     },
  { action: 'export',            subject: 'Customer',     description: 'Export customer list',                              category: 'Customers'     },
  { action: 'archive',           subject: 'Customer',     description: 'Archive / unarchive customers and locations',       category: 'Customers'     },
  { action: 'force_purge',       subject: 'Customer',     description: 'Force-purge a customer subtree (admin-only)',       category: 'Customers'     },
  { action: 'anonymize',         subject: 'Customer',     description: 'Anonymize a customer (admin-only, deferred)',       category: 'Customers'     },
  { action: 'renumber',          subject: 'Customer',     description: 'Edit the customer id number',                       category: 'Customers'     },
  // Lead
  { action: 'create',            subject: 'Lead',         description: 'Create leads',                                      category: 'Leads'         },
  { action: 'read',              subject: 'Lead',         description: 'View leads',                                        category: 'Leads'         },
  { action: 'update',            subject: 'Lead',         description: 'Edit leads and sub-resources (notes, tags)',        category: 'Leads'         },
  { action: 'delete',            subject: 'Lead',         description: 'Delete a lead (no estimate)',                       category: 'Leads'         },
  { action: 'assign',            subject: 'Lead',         description: 'Assign leads to reps',                              category: 'Leads'         },
  { action: 'contact',           subject: 'Lead',         description: 'Log contact on a lead',                             category: 'Leads'         },
  { action: 'mark_lost',         subject: 'Lead',         description: 'Mark a lead as lost',                               category: 'Leads'         },
  { action: 'cancel',            subject: 'Lead',         description: 'Cancel a lead',                                     category: 'Leads'         },
  { action: 'schedule_walkthrough', subject: 'Lead',      description: 'Schedule a walkthrough on a lead',                  category: 'Leads'         },
  { action: 'perform_walkthrough',  subject: 'Lead',      description: 'Record & complete an assigned walkthrough',         category: 'Leads'         },
  { action: 'renumber',          subject: 'Lead',         description: 'Edit the lead id number',                           category: 'Leads'         },
  // Estimate
  { action: 'create',            subject: 'Estimate',     description: 'Create estimates',                                  category: 'Estimates'     },
  { action: 'read',              subject: 'Estimate',     description: 'View estimates',                                    category: 'Estimates'     },
  { action: 'update',            subject: 'Estimate',     description: 'Edit estimates',                                    category: 'Estimates'     },
  { action: 'delete',            subject: 'Estimate',     description: 'Delete estimates',                                  category: 'Estimates'     },
  { action: 'send',              subject: 'Estimate',     description: 'Send estimates to customers',                       category: 'Estimates'     },
  // 'cancel' is the legacy action name — kept as a still-recognized alias because persisted
  // UserPermissionOverride rows reference the literal string 'cancel' (loadUserOverrides.ts
  // passes DB rows straight through with no translation, see defineAbility.ts). 'archive' is
  // the new name (estimate status rename APPROVED→WON, CANCELLED→ARCHIVED); both map to the
  // same underlying check today. Do not remove 'cancel'.
  { action: 'cancel',            subject: 'Estimate',     description: 'Cancel estimates',                                  category: 'Estimates'     },
  { action: 'archive',           subject: 'Estimate',     description: 'Archive estimates (formerly "cancel")',             category: 'Estimates'     },
  { action: 'duplicate',         subject: 'Estimate',     description: 'Duplicate estimates',                               category: 'Estimates'     },
  { action: 'revise',            subject: 'Estimate',     description: 'Recall a sent estimate to draft for revision',      category: 'Estimates'     },
  { action: 'record_payment',    subject: 'Estimate',     description: 'Record deposit payment on estimate',                category: 'Estimates'     },
  { action: 'waive_deposit',     subject: 'Estimate',     description: 'Waive deposit on estimate',                         category: 'Estimates'     },
  // R4 (2026-07-21) — lifecycle verbs (port-plan §10.3, D13). `void_approval` (guarded unwind,
  // WON → SENT) is DELIBERATELY absent here — same shape as LogisticOrder's `approve` above:
  // permanently ADMIN-only, never grantable to another role via the Settings UI.
  { action: 'approve',           subject: 'Estimate',     description: 'Approve an estimate internally (verbal/off-platform win)', category: 'Estimates' },
  { action: 'decline',           subject: 'Estimate',     description: 'Decline an estimate internally (verbal/off-platform loss)', category: 'Estimates' },
  { action: 'renumber',          subject: 'Estimate',     description: 'Edit the estimate id number',                       category: 'Estimates'     },
  // refund_deposit + reactivate_deposit folded into the unified Invoice refund (Phase 5):
  // the deposit refund is now POST /api/invoices/:id/refund on the kind=DEPOSIT invoice.
  // Job
  { action: 'create',            subject: 'Job',          description: 'Create jobs',                                       category: 'Jobs'          },
  { action: 'read',              subject: 'Job',          description: 'View jobs, charges, notes, timeline',               category: 'Jobs'          },
  { action: 'update',            subject: 'Job',          description: 'Edit jobs, charges, notes, walkthrough',            category: 'Jobs'          },
  { action: 'delete',            subject: 'Job',          description: 'Delete jobs',                                       category: 'Jobs'          },
  { action: 'assign',            subject: 'Job',          description: 'Assign job to technician',                          category: 'Jobs'          },
  { action: 'unassign',          subject: 'Job',          description: 'Remove technician from job',                        category: 'Jobs'          },
  { action: 'en_route',          subject: 'Job',          description: 'Mark on the way',                                   category: 'Jobs'          },
  { action: 'arrive',            subject: 'Job',          description: 'Mark job on-site',                                  category: 'Jobs'          },
  { action: 'start',             subject: 'Job',          description: 'Start job',                                         category: 'Jobs'          },
  { action: 'complete',          subject: 'Job',          description: 'Complete job',                                      category: 'Jobs'          },
  { action: 'cancel',            subject: 'Job',          description: 'Cancel job',                                        category: 'Jobs'          },
  { action: 'reopen',            subject: 'Job',          description: 'Reopen a completed job (admin-only)',               category: 'Jobs'          },
  { action: 'reschedule',        subject: 'Job',          description: 'Change a job’s scheduled date/time',                category: 'Jobs'          },
  // Split out of `update Job` (technician-ownership spec, Part C). Mirrors `manage_lines Invoice`
  // below: the money surface of the entity - line items, scopes, and the tax/discount fields that
  // ride the job PATCH - while `update Job` stays the notes/tags/field-edit gate.
  //
  // NO ROLES-UI ROW, deliberately, and the same is true of `manage_lines Invoice`. The Roles editor
  // is a CRUD matrix (read/create/update/delete per module) plus three sensitive switches, and
  // `viewModelToGrants` can emit nothing else - so `manage_lines` is outside MANAGED_KEYS and a Save
  // can neither create nor delete it. A row on that screen would be a control that cannot write.
  // The user-facing label for this action lives where it CAN be flipped: the per-user capability
  // toggle in userCapabilities.ts ("Edit line items on jobs they created").
  //
  // These descriptions are not rendered anywhere - `isCatalogEntry` is the only consumer of this
  // table - so a label here would not have surfaced it either.
  { action: 'manage_lines',      subject: 'Job',          description: 'Add/remove job line items and scopes',              category: 'Jobs'          },
  { action: 'renumber',          subject: 'Job',          description: 'Edit the job id number',                            category: 'Jobs'          },
  // Invoice
  { action: 'create',            subject: 'Invoice',      description: 'Create invoices',                                   category: 'Invoices'      },
  { action: 'read',              subject: 'Invoice',      description: 'View invoices',                                     category: 'Invoices'      },
  { action: 'update',            subject: 'Invoice',      description: 'Edit invoices',                                     category: 'Invoices'      },
  { action: 'delete',            subject: 'Invoice',      description: 'Delete invoices',                                   category: 'Invoices'      },
  { action: 'send',              subject: 'Invoice',      description: 'Send invoices to customers',                        category: 'Invoices'      },
  { action: 'void',              subject: 'Invoice',      description: 'Void invoices (admin-only)',                         category: 'Invoices'      },
  { action: 'refund',            subject: 'Invoice',      description: 'Refund invoice via Stripe (admin-only)',             category: 'Invoices'      },
  { action: 'credit',            subject: 'Invoice',      description: 'Apply a credit / give-back (admin-only)',            category: 'Invoices'      },
  { action: 'void_payment',      subject: 'Invoice',      description: 'Void a manual payment (admin-only)',                 category: 'Invoices'      },
  { action: 'record_payment',    subject: 'Invoice',      description: 'Record payment on invoice',                         category: 'Invoices'      },
  { action: 'manage_lines',      subject: 'Invoice',      description: 'Add/remove invoice line items',                      category: 'Invoices'      },
  { action: 'renumber',          subject: 'Invoice',      description: 'Edit the invoice id number',                        category: 'Invoices'      },
  // PriceBook
  { action: 'read',              subject: 'PriceBook',    description: 'View price book categories and items',              category: 'Price Book'    },
  { action: 'create',            subject: 'PriceBook',    description: 'Create price book items/categories',                category: 'Price Book'    },
  { action: 'update',            subject: 'PriceBook',    description: 'Edit price book items/categories',                  category: 'Price Book'    },
  { action: 'delete',            subject: 'PriceBook',    description: 'Delete price book items/categories',                category: 'Price Book'    },
  // Tag
  { action: 'read',              subject: 'Tag',          description: 'View tags',                                         category: 'Tags'          },
  { action: 'create',            subject: 'Tag',          description: 'Create tags',                                       category: 'Tags'          },
  // Renaming/recolouring and deleting a tag are org-wide edits: a delete detaches the
  // tag from every record it is on. Deliberately ADMIN-only — no defaultGrants row,
  // ADMIN reaches them via `manage all`.
  { action: 'update',            subject: 'Tag',          description: 'Rename or recolour tags org-wide',                   category: 'Tags'          },
  { action: 'delete',            subject: 'Tag',          description: 'Delete tags org-wide (removes them from all records)', category: 'Tags'        },
  // User
  { action: 'create',            subject: 'User',         description: 'Create login users and staff',                      category: 'Users'         },
  { action: 'read',              subject: 'User',         description: 'View users',                                        category: 'Users'         },
  { action: 'update',            subject: 'User',         description: 'Edit users',                                        category: 'Users'         },
  { action: 'delete',            subject: 'User',         description: 'Deactivate users',                                  category: 'Users'         },
  // Scoped assignee pool, slice 1 (plan: md_files/plans/permissions/2026-08-31-assignee-pool/).
  // "Put somebody OTHER THAN YOURSELF on a piece of work." Exactly the `assign Task` shape one
  // subject over (see the Tasks block below) - and the subject is `User` on purpose: what this
  // gates is the set of PEOPLE a caller may name, not the work they are named on. One grant spans
  // a job's crew and a walkthrough's performers, so naming it after either would misdescribe half
  // of what it governs.
  //
  // It does NOT replace `assign Job` / `unassign Job`. Those say WHICH JOBS you may re-crew at
  // all; this says WHOSE NAMES you may put there. A technician holds `assign Job` scoped to jobs
  // they created and this org-wide, and the pair composes to "other people, on my own jobs".
  //
  // Unconditional by design: `User` is not a ScopeResource (enforce.ts), so a condition here would
  // be inert AND misleading. Whether the caller may touch the record at all is already answered by
  // that record's own grant.
  { action: 'assign',            subject: 'User',         description: 'Assign work to people other than yourself (job crew, walkthrough performers)', category: 'Users' },
  // Department
  { action: 'read',              subject: 'Department',   description: 'View departments',                                  category: 'Organization'  },
  { action: 'create',            subject: 'Department',   description: 'Create departments',                                category: 'Organization'  },
  { action: 'update',            subject: 'Department',   description: 'Edit departments',                                  category: 'Organization'  },
  { action: 'delete',            subject: 'Department',   description: 'Delete departments',                                category: 'Organization'  },
  // Organization
  { action: 'read',              subject: 'Organization', description: 'View organization settings',                        category: 'Organization'  },
  { action: 'update',            subject: 'Organization', description: 'Edit organization settings',                        category: 'Organization'  },
  // Report
  { action: 'read',              subject: 'Report',       description: 'View reports',                                      category: 'Reports'       },
  // Pricing (SRVW-140) - the grant `canSeePricing` keys on, written by the Roles UI "See
  // financial data" switch. LOAD-BEARING: putRolePermissions filters `desired` through
  // isCatalogEntry, so without this entry the switch would persist nothing at all.
  { action: 'read',              subject: 'Pricing',      description: 'See financial data (prices, costs and margins)',    category: 'Financial'     },
  // StateTaxRate
  { action: 'read',              subject: 'StateTaxRate', description: 'View state tax rates',                              category: 'System'        },
  // AppSetting
  { action: 'read',              subject: 'AppSetting',   description: 'Read app settings',                                 category: 'System'        },
  { action: 'update',            subject: 'AppSetting',   description: 'Update app settings',                               category: 'System'        },
  // Attachment
  { action: 'create',            subject: 'Attachment',   description: 'Upload attachments',                                category: 'Attachments'   },
  { action: 'read',              subject: 'Attachment',   description: 'View attachments',                                  category: 'Attachments'   },
  { action: 'update',            subject: 'Attachment',   description: 'Edit attachment metadata',                          category: 'Attachments'   },
  { action: 'delete',            subject: 'Attachment',   description: 'Delete attachments',                                category: 'Attachments'   },
  // Inventory
  { action: 'read',              subject: 'Inventory',    description: 'View inventory (stock, locations, movements, staging)', category: 'Inventory'     },
  { action: 'create',            subject: 'Inventory',    description: 'Create inventory records',                          category: 'Inventory'     },
  { action: 'update',            subject: 'Inventory',    description: 'Edit inventory records',                            category: 'Inventory'     },
  { action: 'delete',            subject: 'Inventory',    description: 'Delete inventory records',                          category: 'Inventory'     },
  // Purchasing — PurchaseOrder (POs, RFQs, reservation queue)
  { action: 'read',              subject: 'PurchaseOrder', description: 'View purchase orders, RFQs, and the reservation queue', category: 'Purchasing'    },
  { action: 'create',            subject: 'PurchaseOrder', description: 'Create purchase orders and reservations',           category: 'Purchasing'    },
  { action: 'update',            subject: 'PurchaseOrder', description: 'Edit and receive purchase orders',                  category: 'Purchasing'    },
  { action: 'delete',            subject: 'PurchaseOrder', description: 'Delete purchase orders',                            category: 'Purchasing'    },
  // Purchasing — Vendor
  { action: 'read',              subject: 'Vendor',        description: 'View vendors and vendor contacts',                  category: 'Purchasing'    },
  { action: 'create',            subject: 'Vendor',        description: 'Create vendors',                                    category: 'Purchasing'    },
  { action: 'update',            subject: 'Vendor',        description: 'Edit vendors',                                      category: 'Purchasing'    },
  { action: 'delete',            subject: 'Vendor',        description: 'Delete vendors',                                    category: 'Purchasing'    },
  // Logistic Orders (LO-1). NOTE: no `approve` entry — approve is capability-only
  // (userCapabilities.ts), never a role grant. What ENFORCES that is viewModelToGrants' emittable
  // surface + putRolePermissions' capability drop, not this list — see THE ACTUAL GATE note above.
  { action: 'read',              subject: 'LogisticOrder', description: 'View logistic orders and their lines',              category: 'Logistic Orders' },
  { action: 'create',            subject: 'LogisticOrder', description: 'Create logistic orders',                            category: 'Logistic Orders' },
  { action: 'update',            subject: 'LogisticOrder', description: 'Edit draft logistic orders and their lines',        category: 'Logistic Orders' },
  { action: 'delete',            subject: 'LogisticOrder', description: 'Delete draft logistic orders',                      category: 'Logistic Orders' },
  { action: 'submit',            subject: 'LogisticOrder', description: 'Submit a logistic order for approval',              category: 'Logistic Orders' },
  { action: 'process',           subject: 'LogisticOrder', description: 'Process an approved logistic order (deducts stock)', category: 'Logistic Orders' },
  { action: 'cancel',            subject: 'LogisticOrder', description: 'Cancel a logistic order',                           category: 'Logistic Orders' },
  // Communication
  { action: 'read',              subject: 'Communication', description: 'View communication (calls, threads, templates, config)', category: 'Communication' },
  { action: 'create',            subject: 'Communication', description: 'Create communication records',                     category: 'Communication' },
  { action: 'update',            subject: 'Communication', description: 'Edit communication records',                       category: 'Communication' },
  { action: 'delete',            subject: 'Communication', description: 'Delete communication records',                     category: 'Communication' },
  // Cataloged from slice 1 even though no Roles-UI control writes it until slice 4:
  // putRolePermissions drops every emitted grant that fails isCatalogEntry, so the entry has to
  // exist before the bundle that emits it can persist anything.
  { action: 'log_past',          subject: 'Communication', description: 'Log past communications (calls, texts, emails) by hand', category: 'Communication' },
  // #2046 — the section-level switch (org-wide inbox, call log, phone settings), independent of
  // the per-record `read Communication` above. No vendor name in the description (CLAUDE.md).
  { action: 'access_inbox',      subject: 'Communication', description: 'Open the Communication section (org-wide inbox, call log, phone settings)', category: 'Communication' },
  // Settings — Locations & Roles
  { action: 'read',              subject: 'Location',      description: 'View business locations/branches',                  category: 'Settings'      },
  { action: 'create',            subject: 'Location',      description: 'Create locations',                                  category: 'Settings'      },
  { action: 'update',            subject: 'Location',      description: 'Edit locations',                                    category: 'Settings'      },
  { action: 'delete',            subject: 'Location',      description: 'Delete locations',                                  category: 'Settings'      },
  { action: 'read',              subject: 'Role',          description: 'View roles & permissions',                          category: 'Settings'      },
  { action: 'update',            subject: 'Role',          description: 'Edit role permissions',                             category: 'Settings'      },
  { action: 'read',              subject: 'Timeclock',     description: 'View timeclock configuration & stores',             category: 'Settings'      },
  { action: 'update',            subject: 'Timeclock',     description: 'Configure timeclock: geofence stores, config, per-user settings', category: 'Settings' },
  // Service Plans
  { action: 'read',              subject: 'ServicePlan',   description: 'View service plans',                                category: 'Service Plans' },
  { action: 'create',            subject: 'ServicePlan',   description: 'Create service plans',                              category: 'Service Plans' },
  { action: 'update',            subject: 'ServicePlan',   description: 'Edit / activate / renew / cancel service plans',    category: 'Service Plans' },
  { action: 'delete',            subject: 'ServicePlan',   description: 'Delete draft service plans',                        category: 'Service Plans' },
  // Automation Center
  { action: 'read',              subject: 'Automation',    description: 'View automations and their activity',               category: 'Automations'   },
  { action: 'create',            subject: 'Automation',    description: 'Create automations',                                category: 'Automations'   },
  { action: 'update',            subject: 'Automation',    description: 'Edit / enable / disable / test automations',        category: 'Automations'   },
  { action: 'delete',            subject: 'Automation',    description: 'Delete automations',                                category: 'Automations'   },
  // Tasks
  { action: 'read',              subject: 'Task',          description: 'View tasks',                                        category: 'Tasks'         },
  { action: 'create',            subject: 'Task',          description: 'Create tasks',                                      category: 'Tasks'         },
  { action: 'update',            subject: 'Task',          description: 'Edit tasks (title, status, priority, due date, etc.)', category: 'Tasks'      },
  { action: 'delete',            subject: 'Task',          description: 'Delete tasks',                                      category: 'Tasks'         },
  // Multi-assignee design §3. Without this a caller may only ever put THEMSELVES on a task.
  // ADMIN reaches it through `manage all` (defineAbility.ts:90) — no DEFAULT_GRANTS row exists
  // or is wanted; SALES / DISPATCHER / TECHNICIAN deliberately do not hold it. It is a grant
  // rather than a role test precisely so a custom role (e.g. a sales manager) can be given it.
  { action: 'assign',            subject: 'Task',          description: 'Assign tasks to other people',                      category: 'Tasks'         },
  // Task categories (slice 08). Read is a default grant for every role; the other three are
  // ADMIN-only - no defaultGrants row, ADMIN reaches them via `manage all`.
  { action: 'read',              subject: 'TaskCategory',  description: 'View task categories',                              category: 'Tasks'         },
  { action: 'create',            subject: 'TaskCategory',  description: 'Create task categories',                            category: 'Tasks'         },
  { action: 'update',            subject: 'TaskCategory',  description: 'Rename or recolour task categories',                category: 'Tasks'         },
  { action: 'delete',            subject: 'TaskCategory',  description: 'Delete task categories',                            category: 'Tasks'         },
  // Notifications
  { action: 'read',              subject: 'Notification',  description: 'View own notifications',                            category: 'Notifications' },
  { action: 'update',            subject: 'Notification',  description: 'Mark notifications read/seen',                      category: 'Notifications' },
  { action: 'delete',            subject: 'Notification',  description: 'Dismiss notifications',                             category: 'Notifications' },
  // Calendar Entries (Slice 01, spec §4) - user-facing "Events". Plumbing only: no table, no
  // API and no UI reads/writes a CalendarEntry yet (Slice 02+). ADMIN gets these four via the
  // manage-all bypass, same as every other subject - no ADMIN row anywhere in this catalog.
  { action: 'read',              subject: 'CalendarEntry', description: 'View events',                                        category: 'Calendar'      },
  { action: 'create',            subject: 'CalendarEntry', description: 'Create events',                                      category: 'Calendar'      },
  { action: 'update',            subject: 'CalendarEntry', description: 'Edit events',                                        category: 'Calendar'      },
  { action: 'delete',            subject: 'CalendarEntry', description: 'Delete events',                                      category: 'Calendar'      },
];

export function isCatalogEntry(action: string, subject: string): boolean {
  return PERMISSION_CATALOG.some(e => e.action === action && e.subject === subject);
}
