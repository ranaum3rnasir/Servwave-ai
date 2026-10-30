/* =============================================================================
   Roles & Permissions security, ticket 36b (M17) - the entry points of the retired Company settings switch.

   Not a test file. The routes that asked for `update` on the company or on app settings before the switch retired, the files that
   hold Company settings lists and rates, the reads in them that stay open to everyone, and where each file is mounted.
   permission-company-settings-guard.test.ts checks the list against the route files; the database test reads it to know which
   routes to call.
   ========================================================================== */

/** Every route that asked for `update` on the company or on app settings before 36b: the entry points of the retired switch. */
export const COMPANY_SETTINGS_ROUTES = [
  // The company form, its logo, the sender address and its readers (the eight server checks the switch listed).
  'organization.routes.ts: PATCH /',
  'organization.routes.ts: GET /email-sender',
  'organization.routes.ts: PATCH /email-sender',
  'organization.routes.ts: GET /email-sender/readers',
  'organization.routes.ts: GET /email-sender/readers/candidates',
  'organization.routes.ts: PUT /email-sender/readers/:userId',
  'organization.routes.ts: DELETE /email-sender/readers/:userId',
  'organization.routes.ts: POST /logo',
  // The phone service connection (ticket 36).
  'organization.routes.ts: POST /phone/connect',
  'organization.routes.ts: POST /phone/check-texting-approval',
  'organization.routes.ts: POST /phone/disconnect',
  'organization.routes.ts: POST /connect-ctm',
  'organization.routes.ts: POST /connect-ctm/check-a2p',
  'organization.routes.ts: POST /disconnect-ctm',
  // Tax rates, job sub-statuses, decline reasons, cancel reasons, job types, lead sources, custom fields, app settings.
  'org-tax-rate.routes.ts: POST /', 'org-tax-rate.routes.ts: PATCH /:id', 'org-tax-rate.routes.ts: DELETE /:id',
  'jobSubStatus.routes.ts: POST /', 'jobSubStatus.routes.ts: POST /reorder', 'jobSubStatus.routes.ts: PATCH /:id', 'jobSubStatus.routes.ts: DELETE /:id',
  'lostReasonOption.routes.ts: POST /', 'lostReasonOption.routes.ts: POST /reorder', 'lostReasonOption.routes.ts: PATCH /:code',
  'jobCancelReason.routes.ts: POST /', 'jobCancelReason.routes.ts: POST /reorder', 'jobCancelReason.routes.ts: PATCH /:code',
  'jobType.routes.ts: GET /', 'jobType.routes.ts: POST /', 'jobType.routes.ts: POST /reorder', 'jobType.routes.ts: PATCH /:id',
  'jobType.routes.ts: POST /:id/archive', 'jobType.routes.ts: POST /:id/unarchive', 'jobType.routes.ts: DELETE /:id',
  'leadSource.routes.ts: GET /', 'leadSource.routes.ts: POST /', 'leadSource.routes.ts: PATCH /:id',
  'leadSource.routes.ts: POST /:id/archive', 'leadSource.routes.ts: POST /:id/unarchive', 'leadSource.routes.ts: DELETE /:id',
  'custom-field-definitions.routes.ts: POST /', 'custom-field-definitions.routes.ts: PATCH /:id',
  'settings.routes.ts: PATCH /:key',
  // The phone numbers and caller ID (ticket 36).
  'comm-numbers.routes.ts: POST /numbers/search', 'comm-numbers.routes.ts: POST /numbers/buy', 'comm-numbers.routes.ts: POST /numbers/register-byo',
  'comm-numbers.routes.ts: POST /numbers/refresh', 'comm-numbers.routes.ts: DELETE /numbers/:id',
  'comm-number-assignments.routes.ts: GET /number-assignments', 'comm-number-assignments.routes.ts: PUT /numbers/:id/assignments',
  'comm-number-assignments.routes.ts: PUT /numbers/:id/org-default', 'comm-number-assignments.routes.ts: PUT /users/:userId/default-number',
];

/** The files that hold Company settings lists and rates: everything in them is Admin-checked except the declared open reads. */
export const COMPANY_SETTINGS_FILES = [
  'org-tax-rate.routes.ts', 'jobSubStatus.routes.ts', 'custom-field-definitions.routes.ts', 'leadSource.routes.ts',
  'jobType.routes.ts', 'lostReasonOption.routes.ts', 'jobCancelReason.routes.ts', 'settings.routes.ts',
];

/** Reads in those files that stay open to everyone, each with what the forms and screens read it for. */
export const OPEN_READS: Record<string, string> = {
  'org-tax-rate.routes.ts: GET /': 'the tax rates the estimate, invoice and job forms pick from',
  'jobSubStatus.routes.ts: GET /': 'the job sub-statuses a job\'s status menu offers',
  'custom-field-definitions.routes.ts: GET /': 'the custom fields a record\'s form draws (the company read every signed-in person holds)',
  'lostReasonOption.routes.ts: GET /': 'the decline reasons a rep picks while declining their own estimate',
  'jobCancelReason.routes.ts: GET /': 'the cancel reasons a job\'s cancel menu offers',
  'settings.routes.ts: GET /:key': 'one app setting (the read every signed-in person holds)',
};


/** Where each route file is mounted (app.ts). */
export const MOUNTS: Record<string, string> = {
  'organization.routes.ts': '/api/organization', 'org-tax-rate.routes.ts': '/api/org-tax-rates', 'jobSubStatus.routes.ts': '/api/job-sub-statuses',
  'custom-field-definitions.routes.ts': '/api/custom-field-definitions', 'leadSource.routes.ts': '/api/lead-sources', 'jobType.routes.ts': '/api/job-types',
  'lostReasonOption.routes.ts': '/api/lost-reason-options', 'jobCancelReason.routes.ts': '/api/job-cancel-reasons', 'settings.routes.ts': '/api/settings',
  'comm-numbers.routes.ts': '/api/communication', 'comm-number-assignments.routes.ts': '/api/communication',
};
