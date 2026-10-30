/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.27 - the Communication route-level table.

   One row per route a Communication switch gates. `needs` lists, by catalog key, every switch the route's guards
   ask for: the database table (permission-communication-route-table-db.test.ts) lets the route in with all of
   them on and refuses it with each one off in turn, on a custom role that holds exactly that, and the pure test
   next to it proves the rows are all the routes there are and name exactly the route's switches.

   What an "off" row answers is the same everywhere: 403 "Insufficient permissions" from the `canDo` guard, before
   any record is looked up. No Communication route hides existence at the gate (a 404 here would mean the person got
   past it), so a record that is not theirs, or not there, answers 404 only on an "on" row, and an "on" row passes
   with anything but 401/403. The phone setup tabs (Call flows, Call groups, Training, Blocked callers) sit behind
   the pilot-or-demo org gate as well; the table's org is a demo org so an "on" row reaches the handler.

   The base role of every person the table builds rotates through the catalog's list of built-in roles, so no row
   names one and no row can pass because of one.
   ========================================================================== */

export interface RouteRow {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** The path as the route file spells it (`:id` stands for a record that is not there). */
  path: string;
  /** Every switch the route's guards ask for. */
  needs: string[];
  /** Switches that are not part of the gate but that the route's handler reads (a record tab needs the record). */
  also?: Record<string, boolean | string>;
}

const V = 'view_communication';
const A = 'access_communication';
const C = 'contact_customers';
const EDIT = 'edit_communication_records';
const DEL = 'delete_communication_records';
const ATT = 'attach_conversations';

const COMM = '/api/communication';
const row = (method: RouteRow['method'], path: string, needs: string[], also?: RouteRow['also']): RouteRow => ({
  method, path: path.startsWith('/api') ? path : `${COMM}${path}`, needs, ...(also && { also }),
});

export const COMMUNICATION_ROUTE_ROWS: RouteRow[] = [
  // ─── Calls ───
  row('get', '/calls', [V, A]),
  row('post', '/calls', [C]),
  row('post', '/calls/attribution', [C]),
  row('get', '/calls/outcome', [V]),
  row('get', '/calls/:id', [V]),
  row('get', '/calls/:id/recording', [V, 'play_recording']),
  row('get', '/calls/:id/recording/download', [V, 'download_recording']),
  row('get', '/calls/:id/transcript', [V, 'view_transcript']),
  row('patch', '/calls/:id/job', [ATT]),
  row('patch', '/calls/:id/lead', [ATT]),
  row('get', '/dialer-search', [V]),
  // The phone customer directory reads customers, so the handler also asks for Customers View.
  row('get', '/contacts', [V], { view_customers: true }),
  row('get', '/contacts/:id', [V], { view_customers: true }),
  row('get', '/agents', [V, A]),
  row('get', '/agents/:id', [V, A]),
  row('get', '/unread-counts', [V, A]),
  row('get', '/team-members', [V, A]),

  // ─── Company numbers and the browser phone ───
  row('get', '/my-outbound-number', [C]),
  row('get', '/my-numbers', [C]),
  row('get', '/numbers', [V, A]),
  row('post', '/numbers/sync-if-stale', [V, A]),
  row('patch', '/numbers/:id', [EDIT, A, 'phone_numbers_tab']),
  row('post', '/phone-access', [C, 'office_phone_in_browser']),
  row('get', '/usage', [V, A, 'phone_usage_bar']),

  // ─── The phone setup tabs ───
  row('get', '/call-flows', [V, A, 'call_flows_tab']),
  row('post', '/call-flows', [C, A, 'call_flows_tab']),
  row('get', '/call-flows/:id', [V, A, 'call_flows_tab']),
  row('patch', '/call-flows/:id', [EDIT, A, 'call_flows_tab']),
  row('delete', '/call-flows/:id', [DEL, A, 'call_flows_tab']),
  row('get', '/call-groups', [V, A, 'call_groups_tab']),
  row('post', '/call-groups', [C, A, 'call_groups_tab']),
  row('get', '/call-groups/:id', [V, A, 'call_groups_tab']),
  row('patch', '/call-groups/:id', [EDIT, A, 'call_groups_tab']),
  row('delete', '/call-groups/:id', [DEL, A, 'call_groups_tab']),
  row('get', '/training/scenarios', [V, A, 'training_tab']),
  row('get', '/training/scenarios/:id', [V, A, 'training_tab']),
  row('get', '/training/sessions', [V, A, 'training_tab']),
  row('get', '/training/sessions/:id', [V, A, 'training_tab']),
  row('get', '/blocked', [V, A, 'blocked_callers_tab']),
  row('post', '/blocked', [C, A, 'blocked_callers_tab']),
  row('post', '/blocked/unblock', [DEL, A, 'blocked_callers_tab']),
  row('get', '/blocked/:id', [V, A, 'blocked_callers_tab']),

  // ─── Texts ───
  row('get', '/threads', [V, A]),
  row('get', '/threads/:id', [V]),
  row('patch', '/threads/:id/read', [V]),
  row('patch', '/threads/:id/unread', [V]),
  row('post', '/threads', [C, A]),
  row('post', '/sms', [C]),
  row('patch', '/sms/:id/job', [ATT]),
  row('patch', '/sms/:id/lead', [ATT]),
  row('get', '/whatsapp', [V, A]),
  row('post', '/whatsapp', [C, A]),
  row('get', '/whatsapp/:id', [V, A]),
  row('patch', '/whatsapp/:id/read', [V, A]),
  row('patch', '/whatsapp/:id/unread', [V, A]),
  row('post', '/whatsapp-chats', [C, A]),

  // ─── Message templates and text automations ───
  row('get', '/templates', [V]),
  row('post', '/templates', [EDIT, A]),
  row('get', '/templates/:id', [V, A]),
  row('patch', '/templates/:id', [EDIT, A]),
  row('delete', '/templates/:id', [EDIT, A]),
  row('get', '/automations', ['view_automations', A]),
  row('post', '/automations', ['create_automations', A]),
  row('get', '/automations/:id', ['view_automations', A]),
  row('patch', '/automations/:id', ['edit_automations', A]),
  row('delete', '/automations/:id', ['delete_automations', A]),

  // ─── Email ───
  row('get', '/sending-identity', [V]),
  row('get', '/my-mailbox', [V, A]),
  row('get', '/mailboxes', [V, A]),
  row('get', '/email-groups', [V, A]),
  row('get', '/forward-rules', [V, A]),
  row('get', '/emails', [V, A]),
  row('post', '/emails', [C]),
  row('patch', '/emails/thread-read', [V, A]),
  row('patch', '/emails/thread-unread', [V, A]),
  row('patch', '/emails/threads/:id/assign', [EDIT, A]),
  row('patch', '/emails/threads/:id/archive', [EDIT, A]),
  row('patch', '/emails/threads/:id/snooze', [EDIT, A]),
  row('get', '/emails/attach-source', [V]),
  row('get', '/emails/unmatched', [V, A]),
  row('get', '/emails/unmatched/:id', [V, A]),
  row('patch', '/emails/:id/job', [ATT]),
  row('patch', '/emails/:id/lead', [ATT]),
  row('get', '/emails/:id/customer-candidates', [ATT, A]),
  row('patch', '/emails/:id/customer', [ATT, A]),
  row('patch', '/emails/:id/link', [EDIT, A]),
  row('get', '/emails/:id', [V, A]),
  row('get', '/emails/:id/attachments/:index', [V, A]),

  // ─── The hand-written log ───
  row('post', '/manual-log', ['log_past_communications']),
  row('get', '/manual-log/performers', ['log_past_communications']),
  row('get', '/manual-log/:id', ['log_past_communications']),
  row('put', '/manual-log/:id', ['log_past_communications']),
  row('delete', '/manual-log/:id', ['log_past_communications']),

  // ─── The Communication tab on a record: needs the record's own View as well, never Access Communication ───
  row('get', '/api/jobs/:id/communications', [V], { view_jobs: true, jobs_scope: 'all' }),
  row('get', '/api/leads/:id/communications', [V], { view_leads: true, leads_scope: 'all' }),
  row('get', '/api/customers/:id/communications', [V], { view_customers: true }),
];
