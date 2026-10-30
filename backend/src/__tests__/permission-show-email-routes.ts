/* =============================================================================
   Roles & Permissions security, M7 (ticket 36): the mail routes the record tabs use as well as the Email page.

   Not a test file. They ask for neither the section nor Show Email: the job, lead and customer tabs write to a customer, show
   the "Sending as" line and file one email under their record with no section at all (PRD 10), so they stay with Contact
   customers and Attach conversations. A reply, or a send that names no record, is the Email page's own: sendEmail asks for the
   section and Show Email. permission-show-email-guard.test.ts checks the list against the route file; the database test reads
   it to know which routes Show Email must not be what refuses.
   ========================================================================== */

export const RECORD_TAB_ROUTES: Record<string, string> = {
  'GET /api/communication/sending-identity': 'the "Sending as" line of every compose box, including the job, lead and customer tabs',
  'POST /api/communication/emails': 'the record tabs send through it; a reply, or a send that names no record, is the Email page\'s and sendEmail asks for the section and Show Email',
  'GET /api/communication/emails/attach-source': 'the attach list of the compose box on a record\'s page',
  'PATCH /api/communication/emails/:id/job': 'filing one email under a job from a record tab (Attach conversations)',
  'PATCH /api/communication/emails/:id/lead': 'filing one email under a lead from a record tab (Attach conversations)',
};
