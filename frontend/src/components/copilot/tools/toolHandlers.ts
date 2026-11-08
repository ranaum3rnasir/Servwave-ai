/**
 * Tool handlers — the bridge from Gemini function calls to the authed ServWave
 * API. Reads execute immediately and return a spoken-friendly summary. Writes do
 * NOT touch the API: they return a hash-pinned approval card; only commitAction()
 * (after the user confirms) calls the API. This is the fail-closed gate.
 */
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { TOOL_SPECS } from './toolRegistry';
import { prepareAction, verifyUnchanged, type PreparedAction } from './approval';
import { formatExactDay } from '@/lib/format-date';

type Args = Record<string, unknown>;

export type ToolOutcome =
  | { kind: 'immediate'; output: string; label?: string }
  | { kind: 'approval'; action: PreparedAction; speak: string }
  | { kind: 'error'; output: string };

export type CommitResult =
  | { ok: true; resultText: string }
  | { ok: false; error: string };

/**
 * Tool results carry record ids as `[id:…]` / `[location_id:…]` so the model
 * can chain lookups into actions. Those ids are internal plumbing — strip them
 * from anything shown to or spoken at the user (the persona also tells the
 * model not to echo them, but smaller models slip).
 */
export function stripInternalIds(text: string): string {
  return text.replace(/\s*\[(?:location_)?id:[^\]]*\]/gi, '');
}

// ─── Entry point ───

export async function handleToolCall(name: string, args: Args): Promise<ToolOutcome> {
  const spec = TOOL_SPECS[name];
  if (!spec) return { kind: 'error', output: `I don't have a tool called "${name}".` };

  if (spec.mode === 'read') {
    try {
      const output = await readTool(name, args);
      return { kind: 'immediate', output };
    } catch (e) {
      return { kind: 'error', output: humanError(e) };
    }
  }

  if (spec.mode === 'draft') {
    const body = String((args.body as string | undefined) ?? '').trim();
    if (!body) return { kind: 'error', output: 'I need the message text to draft.' };
    return {
      kind: 'immediate',
      label: 'draft_only_not_sent',
      output: `Here is the draft (NOT SENT — you'll need to send it yourself):\n\n${body}`,
    };
  }

  // write
  try {
    const action = await buildWrite(name, args);
    return { kind: 'approval', action, speak: `${action.summary} — I've prepared it. Confirm to proceed?` };
  } catch (e) {
    return { kind: 'error', output: humanError(e) };
  }
}

// ─── Reads ───

async function readTool(name: string, args: Args): Promise<string> {
  if (name === 'get_briefing') {
    const { data } = await api.get('/api/dashboard');
    return summarizeBriefing(data?.data ?? data);
  }
  if (name === 'list_users') {
    const { data } = await api.get('/api/users');
    const all: Rec[] = Array.isArray(data?.users) ? data.users : [];
    const q = String(args.query ?? '').trim().toLowerCase();
    const users = (q
      ? all.filter((u) => `${u.first_name ?? ''} ${u.last_name ?? ''} ${u.email ?? ''}`.toLowerCase().includes(q))
      : all
    ).filter((u) => u.is_active !== false);
    if (!users.length) return q ? `No staff member matching "${args.query}".` : 'No staff found.';
    const lines = users.slice(0, 15).map((u) => `• ${u.first_name ?? ''} ${u.last_name ?? ''} — ${u.role ?? ''} [id:${u.id}]`.trim());
    return `${users.length} staff:\n${lines.join('\n')}`;
  }
  // query_crm
  const resource = String(args.resource ?? '');

  // Detail lookup: one record, everything about it (incl. the ids the model
  // needs to chain into actions — e.g. a customer's service_location ids).
  if (args.record_id && resource !== 'search') {
    const { data } = await api.get(`/api/${resource}/${args.record_id}`);
    return summarizeDetail(resource, data);
  }

  // The model's free-text filter. Every list endpoint takes it as `search`
  // (the registry exposes it as `query`; map it here — sending the wrong key
  // silently returns EVERYTHING, which reads like "not connected to the data").
  const search = String(args.query ?? args.search ?? '').trim();

  switch (resource) {
    case 'jobs': {
      const params = pick(args, ['status', 'assigned_to', 'customer_id', 'scheduled_after', 'scheduled_before']);
      const { items, stats, total } = await listWithSearch('/api/jobs', params, search, 'jobs');
      return summarizeList('job', items, (j: Rec) => `${j.job_number ?? '—'} ${j.status ?? ''} — ${customerName(j.customer)}${j.scheduled_start ? `, ${when(j.scheduled_start)}` : ''} [id:${j.id}]`, { stats, total });
    }
    case 'leads': {
      const params = pick(args, ['status', 'assigned_to', 'customer_id']);
      const { items, stats, total } = await listWithSearch('/api/leads', params, search, 'leads');
      return summarizeList('lead', items, (l: Rec) => `${l.lead_number ?? '—'} ${l.status ?? ''} — ${customerName(l.customer)}: ${truncate(l.service_request, 60)} [id:${l.id}]`, { stats, total });
    }
    case 'estimates': {
      const params = pick(args, ['status', 'customer_id']);
      const { items, stats, total } = await listWithSearch('/api/estimates', params, search, 'estimates');
      return summarizeList('estimate', items, (e: Rec) => `${e.estimate_number ?? '—'} ${e.status ?? ''} — ${customerName(e.lead?.customer)}, ${money(e.total_amount)} [id:${e.id}]`, { stats, total });
    }
    case 'invoices': {
      const params = pick(args, ['status', 'customer_id']);
      if (args.overdue) params.overdue = true;
      const { items, stats, total } = await listWithSearch('/api/invoices', params, search, 'invoices');
      return summarizeList('invoice', items, (i: Rec) => `${i.invoice_number ?? '—'} ${i.status ?? ''} — ${customerName(i.job?.customer ?? i.customer)}, due ${money(i.amount_due)} [id:${i.id}]`, { stats, total });
    }
    case 'customers': {
      const { items, total } = await listWithSearch('/api/customers', {}, search, 'customers');
      if (!items.length && search) return `No customers matching "${search}".${roleScopeCaveat()}`;
      // Org-wide numbers for "how many customers do we have?" — only meaningful unfiltered.
      let stats: Rec | undefined;
      if (!search) stats = await api.get('/api/customers/stats').then((r) => r.data).catch(() => undefined);
      return summarizeList('customer', items, (c: Rec) => `${c.customer_number ?? ''} ${customerName(c)} — ${c.phone ?? 'no phone'}${c.email ? `, ${c.email}` : ''} [id:${c.id}]`.trim(), { stats, total });
    }
    case 'search': {
      const { data } = await api.get('/api/search', { params: { q: search } });
      const out = summarizeSearch(data?.results);
      return out === 'No matches found.' ? `${out}${roleScopeCaveat()}` : out;
    }
    default:
      return `I can look up jobs, leads, estimates, invoices, customers, or run a search — which would you like?`;
  }
}

/**
 * Global search and customer lists are role-narrowed server-side (TECHNICIAN:
 * own jobs only, no customers; SALES: own leads/estimates). Without this
 * caveat Servy would assert false negatives ("that customer doesn't exist")
 * to those roles.
 */
function roleScopeCaveat(): string {
  const role = useAuthStore.getState().user?.role;
  if (role === 'TECHNICIAN') return ' (Note: as a technician your search only covers your own assigned jobs — the record may exist outside your scope.)';
  if (role === 'SALES') return ' (Note: as sales your search only covers your own leads and estimates — the record may exist outside your scope.)';
  return '';
}

/**
 * List with a free-text search, with a multi-word fallback. The list endpoints
 * match the WHOLE string against each field, so "Ran Test" (a first + last
 * name) matches nothing even though customer "Ran Test" exists. When the full
 * string finds nothing, retry per word and rank by how many words each record
 * matched — full-name lookups then come back with the right person first.
 */
async function listWithSearch(
  path: string,
  baseParams: Record<string, unknown>,
  search: string,
  key: string,
): Promise<{ items: Rec[]; stats?: Rec; total?: number }> {
  const fetch = async (s?: string): Promise<{ items: Rec[]; stats?: Rec; total?: number }> => {
    const params = { ...baseParams, ...(s ? { search: s } : {}) };
    const { data } = await api.get(path, { params });
    return {
      items: Array.isArray(data?.[key]) ? (data[key] as Rec[]) : [],
      stats: data?.stats,
      // Lists are paginated (default 25) — pagination.total is the REAL count;
      // answering "how many X" with items.length would just echo the page size.
      total: typeof data?.pagination?.total === 'number' ? data.pagination.total : undefined,
    };
  };

  const direct = await fetch(search || undefined);
  if (!search || direct.items.length > 0) return direct;

  const words = search.split(/\s+/).filter((w) => w.length >= 2).slice(0, 3);
  if (words.length < 2) return direct;

  const perWord = await Promise.all(words.map((w) => fetch(w).catch(() => ({ items: [] as Rec[] }))));
  const ranked = new Map<string, { item: Rec; hits: number }>();
  for (const r of perWord) {
    for (const item of r.items) {
      const id = String(item.id);
      const entry = ranked.get(id);
      if (entry) entry.hits += 1;
      else ranked.set(id, { item, hits: 1 });
    }
  }
  // Keep only the best tier: records matching ALL the words beat partial hits
  // ("Art Nakamura" returns just Art Nakamura, not every "art" substring like
  // "Bartlett"). Partial hits only surface when nothing matches every word.
  const all = [...ranked.values()];
  const bestHits = all.reduce((m, e) => Math.max(m, e.hits), 0);
  const items = all.filter((e) => e.hits === bestHits).map((e) => e.item).slice(0, 20);
  return { items };
}

// ─── Write builders (no API call beyond lookups — just the approval card) ───
// A thrown Error here goes back to the MODEL as the tool result, BEFORE any
// card renders — that is how Servy collects missing required fields
// conversationally instead of failing after the user already confirmed.

async function buildWrite(name: string, args: Args): Promise<PreparedAction> {
  switch (name) {
    case 'create_lead': {
      // Resolve customer_name → existing customer HERE, deterministically. The
      // model reliably calls create_lead with just the name it heard; making it
      // route through query_crm first is exactly the instruction weak models
      // skip — which left Servy interrogating users for details of customers
      // that already exist.
      let customerId = args.customer_id ? String(args.customer_id) : undefined;
      let resolvedWho: string | undefined;
      const nameToFind = typeof args.customer_name === 'string' ? args.customer_name.trim() : '';
      if (!customerId && !args.new_customer && nameToFind) {
        const { items } = await listWithSearch('/api/customers', {}, nameToFind, 'customers');
        const only = items.length === 1 ? items[0] : undefined;
        if (only) {
          customerId = String(only.id);
          resolvedWho = `${customerName(only)}${only.customer_number ? ` (${only.customer_number})` : ''}`;
        } else if (items.length > 1) {
          const top = items
            .slice(0, 5)
            .map((c: Rec) => `${c.customer_number ?? ''} ${customerName(c)} — ${c.phone ?? 'no phone'} [id:${c.id}]`.trim())
            .join('; ');
          throw new Error(
            `Multiple existing customers match "${nameToFind}": ${top}. Ask the user which one, then call create_lead again with that customer_id.`,
          );
        } else {
          throw new Error(
            `No existing customer matches "${nameToFind}". Ask the user whether this is a new customer; if so, collect their full name, email, phone and service address — ONE question at a time — then call create_lead with new_customer.`,
          );
        }
      }
      const hasExisting = Boolean(customerId);
      const hasNew = Boolean(args.new_customer);
      if (hasExisting === hasNew) {
        throw new Error(
          hasExisting
            ? 'Give me EITHER an existing customer OR new-customer details — not both.'
            : 'Who is the customer for this lead? Call create_lead again with their name as customer_name — I will find them.',
        );
      }
      if (!String(args.service_request ?? '').trim()) {
        throw new Error('What work does the customer need done? I need a short service request description from the user — do not make one up.');
      }
      const payload = clean({
        customer_id: customerId,
        new_customer: args.new_customer,
        service_location_id: args.service_location_id,
        new_location: args.new_location,
        service_request: args.service_request,
        notes: args.notes,
      });
      const who = customerId
        ? resolvedWho ?? 'an existing customer'
        : customerName(args.new_customer as Rec);
      const loc = (args.new_location ?? (args.new_customer as Rec | undefined)?.location) as Rec | undefined;
      const override = args.override === true;
      return prepareAction({
        capabilityId: 'create_lead',
        toolName: 'create_lead',
        summary: `${override ? 'Create a lead AND a possible duplicate customer' : 'Create a lead'} for ${who}`,
        detail: [
          { label: 'Customer', value: who },
          { label: 'Request', value: truncate(args.service_request, 120) },
          ...(loc ? [{ label: 'Address', value: `${loc.address_line1 ?? ''}, ${loc.city ?? ''} ${loc.state ?? ''}` }] : []),
        ],
        endpoint: { method: 'POST', path: override ? '/api/leads?override=true' : '/api/leads' },
        payload,
      });
    }
    case 'schedule_walkthrough': {
      if (String(args.action) === 'unschedule') {
        return prepareAction({
          capabilityId: 'schedule_walkthrough',
          toolName: 'schedule_walkthrough',
          summary: `Unschedule the walkthrough on lead ${args.lead_id}`,
          detail: [{ label: 'Note', value: 'Lead returns to CONTACTED; performers are kept; no email is sent' }],
          endpoint: { method: 'POST', path: `/api/leads/${args.lead_id}/walkthrough/unschedule` },
          payload: {},
        });
      }
      if (!args.walkthrough_scheduled_at) {
        throw new Error('When should the walkthrough happen? I need a date and time.');
      }
      const performers = Array.isArray(args.performer_ids) ? (args.performer_ids as string[]) : [];
      const payload = clean({
        walkthrough_scheduled_at: args.walkthrough_scheduled_at,
        performer_ids: performers,
        walkthrough_duration_minutes: args.walkthrough_duration_minutes,
        send_email: args.send_email,
        force: args.force,
      });
      return prepareAction({
        capabilityId: 'schedule_walkthrough',
        toolName: 'schedule_walkthrough',
        summary: `Schedule a walkthrough on lead ${args.lead_id} (${performers.length} performer${performers.length === 1 ? '' : 's'})`,
        detail: [
          { label: 'When', value: when(args.walkthrough_scheduled_at) },
          { label: 'Performers', value: performers.length ? `${performers.length} (REPLACES current)` : 'none yet — customer email suppressed' },
          ...(args.force ? [{ label: 'Force', value: 'yes — overriding a schedule conflict' }] : []),
        ],
        endpoint: { method: 'POST', path: `/api/leads/${args.lead_id}/walkthrough/schedule` },
        payload,
      });
    }
    case 'create_estimate': {
      const items = Array.isArray(args.line_items) ? (args.line_items as Rec[]) : [];
      const total = items.reduce((s, li) => s + Number(li.quantity ?? 0) * Number(li.unit_price ?? 0), 0);
      const payload = clean({
        lead_id: args.lead_id,
        scope_notes: args.scope_notes,
        tax_rate: args.tax_rate,
        discount_type: args.discount_type,
        discount_value: args.discount_value,
        discount_name: args.discount_name,
        line_items: items,
      });
      const discount = args.discount_type
        ? `${args.discount_value}${args.discount_type === 'PERCENTAGE' ? '%' : ' (fixed)'}${args.discount_name ? ` — ${args.discount_name}` : ''}`
        : undefined;
      return prepareAction({
        capabilityId: 'create_estimate',
        toolName: 'create_estimate',
        summary: `Create an estimate (${items.length} line item${items.length === 1 ? '' : 's'}, ~${money(total)})`,
        detail: [
          ...items.map((li, i) => ({ label: `Line ${i + 1}`, value: `${truncate(li.description, 50)} ×${li.quantity} @ ${money(li.unit_price)}` })),
          ...(discount ? [{ label: 'Discount', value: discount }] : []),
        ],
        endpoint: { method: 'POST', path: '/api/estimates' },
        payload,
      });
    }
    case 'create_job': {
      if (!args.estimate_id && !(args.customer_id && args.service_location_id)) {
        throw new Error(
          'Which approved estimate is this job from? Or, for a standalone job, which customer AND which of their service locations? (Location ids are in the customer detail.)',
        );
      }
      const payload = clean({
        estimate_id: args.estimate_id,
        customer_id: args.customer_id,
        service_location_id: args.service_location_id,
        scope_notes: args.scope_notes,
        scheduled_start: args.scheduled_start,
        scheduled_end: args.scheduled_end,
      });
      return prepareAction({
        capabilityId: 'create_job',
        toolName: 'create_job',
        summary: args.estimate_id ? 'Create a job from the estimate' : 'Create a job',
        detail: Object.entries(payload).map(([k, v]) => ({ label: k, value: String(v) })),
        endpoint: { method: 'POST', path: '/api/jobs' },
        payload,
      });
    }
    case 'create_invoice': {
      return prepareAction({
        capabilityId: 'create_invoice',
        toolName: 'create_invoice',
        summary: 'Invoice the job from its Items tab',
        detail: [{ label: 'Job', value: String(args.job_id) }],
        // SRVW-85: stays POST /api/invoices. Now that this door bills the job's Items tab it IS
        // the right one for "invoice this job" - it is the only one that sets a due_date and the
        // only one with a one-active guard, and the job door would need line ids prefetched.
        endpoint: { method: 'POST', path: '/api/invoices' },
        payload: { job_id: args.job_id },
        isFinancial: true,
      });
    }
    case 'update_job_status': {
      const action = String(args.action);
      const route = action === 'en_route' ? 'en-route' : action;
      if (action === 'cancel' && !String(args.cancelled_reason ?? '').trim()) {
        throw new Error('I need a cancellation reason before I can prepare this — what should I record?');
      }
      if (action === 'assign') {
        // The API refines start+end both-or-neither (all-day: start only is fine).
        if (Boolean(args.scheduled_start) !== Boolean(args.scheduled_end) && !args.is_all_day && !args.scheduled_end) {
          throw new Error('I need an end time too (or tell me it is an all-day job).');
        }
        // assignee_ids is the FULL new crew (REPLACE). When the model omits it
        // (e.g. only changing times), preserve the current crew instead of
        // silently wiping it.
        let assigneeIds = Array.isArray(args.assignee_ids) ? (args.assignee_ids as string[]) : undefined;
        if (assigneeIds === undefined) {
          assigneeIds = await currentCrew(String(args.job_id));
        }
        const payload = clean({
          assignee_ids: assigneeIds,
          scheduled_start: args.scheduled_start,
          scheduled_end: args.scheduled_end,
          is_all_day: args.is_all_day,
          force: args.force,
        });
        return prepareAction({
          capabilityId: 'update_job_status',
          toolName: 'update_job_status',
          summary: `Schedule job ${args.job_id} (${assigneeIds.length} crew)`,
          detail: [
            { label: 'Action', value: 'assign (crew REPLACES current)' },
            { label: 'Crew size', value: String(assigneeIds.length) },
            ...(args.scheduled_start ? [{ label: 'Start', value: String(args.scheduled_start) }] : []),
            ...(args.scheduled_end ? [{ label: 'End', value: String(args.scheduled_end) }] : []),
            ...(args.force ? [{ label: 'Force', value: 'yes — overriding a schedule conflict' }] : []),
          ],
          endpoint: { method: 'POST', path: `/api/jobs/${args.job_id}/assign` },
          payload,
        });
      }
      const payload = clean({
        completion_notes: args.completion_notes,
        cancelled_reason: args.cancelled_reason,
      });
      return prepareAction({
        capabilityId: 'update_job_status',
        toolName: 'update_job_status',
        summary: `Mark job ${args.job_id} → ${action}`,
        detail: [{ label: 'Action', value: action }, ...Object.entries(payload).map(([k, v]) => ({ label: k, value: String(v) }))],
        endpoint: { method: 'POST', path: `/api/jobs/${args.job_id}/${route}` },
        payload,
      });
    }
    case 'reschedule_job': {
      // POST /:id/assign is the canonical scheduler — it flips status, runs
      // conflict detection and emails the customer. A bare PATCH does none of
      // that. Re-send the current crew (assign REPLACES the crew list).
      const crew = await currentCrew(String(args.job_id));
      return prepareAction({
        capabilityId: 'reschedule_job',
        toolName: 'reschedule_job',
        summary: `Reschedule job ${args.job_id}`,
        detail: [
          { label: 'New start', value: String(args.scheduled_start) },
          { label: 'New end', value: String(args.scheduled_end) },
          { label: 'Crew', value: `kept (${crew.length})` },
        ],
        endpoint: { method: 'POST', path: `/api/jobs/${args.job_id}/assign` },
        payload: {
          assignee_ids: crew,
          scheduled_start: args.scheduled_start,
          scheduled_end: args.scheduled_end,
        },
      });
    }
    case 'update_estimate_status': {
      const action = String(args.action);
      if (action === 'cancel') {
        if (!String(args.cancelled_reason ?? '').trim()) {
          throw new Error("What's the reason for cancelling? I need it for the record.");
        }
        return prepareAction({
          capabilityId: 'update_estimate_status',
          toolName: 'update_estimate_status',
          summary: `Cancel estimate ${args.estimate_id}`,
          detail: [{ label: 'Reason', value: truncate(args.cancelled_reason, 120) }],
          endpoint: { method: 'POST', path: `/api/estimates/${args.estimate_id}/cancel` },
          payload: { cancelled_reason: String(args.cancelled_reason) },
        });
      }
      // Sending emails the customer immediately and fixes the deposit terms —
      // a financial decision the USER makes, never a silent default.
      if (typeof args.deposit_required !== 'boolean') {
        throw new Error('Should this estimate require a deposit? (The org default is yes.) I need the answer before sending.');
      }
      const methods = Array.isArray(args.payment_methods) ? (args.payment_methods as string[]) : [];
      if (args.deposit_required === true && methods.length === 0) {
        throw new Error('Which payment methods should the customer be able to use for the deposit — card, bank transfer, check, or cash?');
      }
      const payload = clean({
        deposit_required: args.deposit_required,
        payment_methods: methods.length ? methods : undefined,
      });
      return prepareAction({
        capabilityId: 'update_estimate_status',
        toolName: 'update_estimate_status',
        summary: `Send estimate ${args.estimate_id} to the customer`,
        detail: [
          { label: 'Deposit required', value: args.deposit_required ? 'yes' : 'no' },
          ...(methods.length ? [{ label: 'Payment methods', value: methods.join(', ') }] : []),
          { label: 'Note', value: 'Emails the customer immediately' },
        ],
        endpoint: { method: 'POST', path: `/api/estimates/${args.estimate_id}/send` },
        payload,
        isFinancial: true,
      });
    }
    case 'add_note': {
      const plural: Record<string, string> = { lead: 'leads', customer: 'customers', job: 'jobs', estimate: 'estimates', invoice: 'invoices' };
      const entity = String(args.entity_type);
      const base = plural[entity];
      if (!base) throw new Error(`I can't add a note to "${entity}".`);
      return prepareAction({
        capabilityId: 'add_note',
        toolName: 'add_note',
        summary: `Add a note to the ${entity}`,
        detail: [{ label: 'Note', value: truncate(args.content, 160) }],
        endpoint: { method: 'POST', path: `/api/${base}/${args.entity_id}/notes` },
        payload: { content: String(args.content) },
      });
    }
    case 'create_customer': {
      const payload = clean({
        first_name: args.first_name,
        last_name: args.last_name,
        company_name: args.company_name,
        email: args.email,
        phone: args.phone,
        ad_source: args.ad_source,
        locations: args.locations,
      });
      if (!(payload.first_name || payload.company_name)) {
        throw new Error('I need either a first name or a company name before I can prepare this.');
      }
      if (!(payload.phone || payload.email)) {
        throw new Error('I need either a phone number or an email before I can prepare this.');
      }
      const override = args.override === true;
      return prepareAction({
        capabilityId: 'create_customer',
        toolName: 'create_customer',
        summary: `${override ? 'Create DUPLICATE customer' : 'Create customer'} ${customerName(payload as Rec)}`,
        detail: [
          ...(args.email ? [{ label: 'Email', value: String(args.email) }] : []),
          ...(args.phone ? [{ label: 'Phone', value: String(args.phone) }] : []),
        ],
        endpoint: { method: 'POST', path: override ? '/api/customers?override=true' : '/api/customers' },
        payload,
      });
    }
    case 'update_customer': {
      const { customer_id, ...rest } = args;
      const payload = clean(rest);
      return prepareAction({
        capabilityId: 'update_customer',
        toolName: 'update_customer',
        summary: `Update customer ${customer_id}`,
        detail: Object.entries(payload).map(([k, v]) => ({ label: k, value: String(v) })),
        endpoint: { method: 'PATCH', path: `/api/customers/${customer_id}` },
        payload,
      });
    }
    default:
      throw new Error(`I can't perform "${name}" yet.`);
  }
}

/**
 * The job's current crew as user ids — needed because POST /:id/assign takes
 * the FULL replacement crew (omitting members removes them).
 */
async function currentCrew(jobId: string): Promise<string[]> {
  if (!jobId || jobId === 'undefined') throw new Error('Which job? I need the job id (look it up first).');
  try {
    const { data } = await api.get(`/api/jobs/${jobId}`);
    const assignees = data?.job?.assignees ?? data?.assignees;
    return Array.isArray(assignees)
      ? assignees.map((a: Rec) => String(a.user?.id ?? a.user_id ?? '')).filter(Boolean)
      : [];
  } catch {
    throw new Error("I couldn't load that job to check its current crew — is the job id right?");
  }
}

// ─── Commit (after approval) ───

export async function commitAction(action: PreparedAction): Promise<CommitResult> {
  if (!verifyUnchanged(action)) {
    return { ok: false, error: 'The action changed since you approved it, so I cancelled it for safety. Please try again.' };
  }
  try {
    const data = await request(action.endpoint.method, action.endpoint.path, action.payload);
    return { ok: true, resultText: formatResult(action.toolName, data) };
  } catch (e) {
    // A 409 is never auto-retried: the user approved THIS action, not its
    // override variant. Relay the structured conflict so the model can offer
    // the legitimate next step (and a NEW approval card if the user opts in).
    if (status(e) === 409) return { ok: false, error: conflict409(action.toolName, e) };
    return { ok: false, error: humanError(e) };
  }
}

/** Turn a structured 409 into instructions the model can act on. */
function conflict409(toolName: string, e: unknown): string {
  const data = (e as { response?: { data?: Rec } })?.response?.data ?? {};
  const existing = data.existing as Rec | undefined;
  if (existing && (toolName === 'create_lead' || toolName === 'create_customer')) {
    const name = customerName(existing);
    const bits = [existing.customer_number, name, existing.email, existing.phone].filter(Boolean).join(' · ');
    const archived = existing.is_active === false ? ' (ARCHIVED)' : '';
    const attach = toolName === 'create_lead' ? ` To use them, call create_lead again with customer_id from [id:${existing.id}].` : '';
    return `Not created — a customer with that email or phone already exists: ${bits}${archived} [id:${existing.id}]. Tell the user and prefer using the existing customer.${attach} Only if the user explicitly wants a duplicate, call the tool again with override:true (a new confirmation will be required; the override is audited).`;
  }
  const conflicts = data.conflicts as Rec[] | undefined;
  if (Array.isArray(conflicts) && conflicts.length) {
    const lines = conflicts.slice(0, 5).map((c) => `• ${c.type ?? ''} ${c.number ?? ''}: ${when(c.start)} – ${when(c.end)}`.trim());
    return `Not scheduled — schedule conflict detected:\n${lines.join('\n')}\nTell the user. Only if they accept the clash, call the same tool again with force:true (a new confirmation will be required).`;
  }
  if (toolName === 'create_invoice') {
    return `${data.error ?? 'This job already has an active invoice.'} The existing invoice must be voided first (from the invoice page — Servy cannot void invoices).`;
  }
  return String(data.error ?? 'That conflicts with an existing record, so nothing was changed.');
}

async function request(method: string, path: string, payload: Record<string, unknown>): Promise<Rec> {
  let res;
  if (method === 'POST') res = await api.post(path, payload);
  else if (method === 'PATCH') res = await api.patch(path, payload);
  else if (method === 'DELETE') res = await api.delete(path);
  else res = await api.get(path, { params: payload });
  return (res as { data: Rec }).data;
}

function formatResult(toolName: string, data: Rec): string {
  switch (toolName) {
    case 'create_lead': return `Created lead ${data?.lead?.lead_number ?? ''}`.trim();
    case 'create_estimate': return `Created estimate ${data?.estimate?.estimate_number ?? ''}`.trim();
    case 'create_job': return `Created job ${data?.job?.job_number ?? ''}`.trim();
    case 'create_invoice': return `Created invoice ${data?.invoice?.invoice_number ?? ''}`.trim();
    case 'create_customer': return `Created customer ${data?.customer?.customer_number ?? ''}`.trim();
    case 'update_customer': return 'Customer updated';
    case 'update_job_status': return 'Job status updated';
    case 'reschedule_job': return 'Job rescheduled';
    case 'update_estimate_status': return 'Estimate updated';
    case 'schedule_walkthrough': return 'Walkthrough updated';
    case 'add_note': return 'Note added';
    default: return 'Done';
  }
}

// ─── Error mapping ───

function status(e: unknown): number | undefined {
  return (e as { response?: { status?: number } })?.response?.status;
}

export function humanError(e: unknown): string {
  const s = status(e);
  // Not an HTTP failure → a deliberate conversational throw from buildWrite
  // ("I need a cancellation reason…"). Pass it to the model verbatim so it can
  // ask the user for exactly what's missing.
  if (s === undefined && e instanceof Error && e.message) return e.message;
  const detail = (e as { response?: { data?: { error?: string; details?: { message?: string }[] } } })?.response?.data;
  if (s === 403) return "You don't have permission to do that.";
  if (s === 404) return "I couldn't find that record.";
  if (s === 409) return detail?.error ?? 'That conflicts with an existing record, so nothing was changed.';
  if (s === 400) {
    const first = detail?.details?.[0]?.message;
    return first ? `That didn't validate: ${first}` : (detail?.error ?? 'That request was invalid.');
  }
  if (s === 401) return 'Your session expired — please sign in again.';
  return detail?.error ?? 'Something went wrong. Nothing was changed.';
}

// ─── Summarizers + small helpers ───

type Rec = Record<string, any>;

function summarizeList(
  noun: string,
  items: Rec[] | undefined,
  label: (x: Rec) => string,
  opts?: { stats?: Rec; total?: number },
): string {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return `No ${noun}s found.`;
  const total = typeof opts?.total === 'number' && opts.total >= list.length ? opts.total : list.length;
  const head = list.slice(0, 8).map((x) => `• ${label(x)}`).join('\n');
  const shown = Math.min(list.length, 8);
  const more = total > shown ? `\n…and ${total - shown} more.` : '';
  const stats = opts?.stats;
  const statLine = stats ? `\n(${flattenStats(stats).join(', ')})` : '';
  const heading = total > shown ? `${total} ${noun}s — showing the first ${shown}` : `${total} ${noun}${total === 1 ? '' : 's'}`;
  return `${heading}:\n${head}${more}${statLine}`;
}

/** Flatten a stats object one level deep ({a:1, b:{c:2}} → ['a: 1', 'b.c: 2']). */
function flattenStats(stats: Rec): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === 'number') out.push(`${k}: ${v}`);
    else if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as Rec)) {
        if (typeof v2 === 'number') out.push(`${k}.${k2}: ${v2}`);
      }
    }
  }
  return out;
}

function summarizeSearch(results: Rec | undefined): string {
  if (!results) return 'No matches found.';
  const sections: string[] = [];
  for (const key of ['customers', 'jobs', 'leads', 'estimates', 'invoices']) {
    const arr = results[key];
    if (!Array.isArray(arr) || arr.length === 0) continue;
    const lines = arr.slice(0, 5).map((r: Rec) => {
      const bits = [r.title, r.subtitle, r.status, r.phone, r.total != null ? money(r.total) : null]
        .filter(Boolean)
        .join(' — ');
      return `• ${bits} [id:${r.id}]`;
    });
    sections.push(`${key} (${arr.length}):\n${lines.join('\n')}`);
  }
  return sections.length ? sections.join('\n') : 'No matches found.';
}

/** One record, in full — including the child ids the model needs to act. */
function summarizeDetail(resource: string, data: Rec | undefined): string {
  const d: Rec = data?.customer ?? data?.lead ?? data?.job ?? data?.estimate ?? data?.invoice ?? data ?? {};
  if (!d || !d.id) return 'I could not load that record.';
  const lines: string[] = [];
  const push = (label: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') lines.push(`${label}: ${v}`);
  };

  if (resource === 'customers') {
    push('Customer', `${d.customer_number ?? ''} ${customerName(d)} [id:${d.id}]`.trim());
    push('Phone', d.phone);
    push('Email', d.email);
    const locs = Array.isArray(d.service_locations) ? d.service_locations : [];
    for (const loc of locs.slice(0, 5)) {
      push(
        loc.is_primary ? 'Location (primary)' : 'Location',
        `${loc.address_line1 ?? ''}, ${loc.city ?? ''} ${loc.state ?? ''} [location_id:${loc.id}]`,
      );
    }
    // GET /api/customers/:id returns { customer, summary } — summary is a
    // SIBLING with the money answers ("how much do they owe us?").
    const fin = (data as Rec)?.summary?.financials;
    if (fin) {
      push('Lifetime revenue', money(fin.lifetime_revenue));
      push('Open balance', `${money(fin.due_balance)}${Number(fin.past_due_balance) > 0 ? ` (past due: ${money(fin.past_due_balance)})` : ''}`);
    }
    const jobs = Array.isArray(d.jobs) ? d.jobs : [];
    if (jobs.length) {
      lines.push(`Recent jobs (${jobs.length}):`);
      for (const j of jobs.slice(0, 5)) lines.push(`• ${j.job_number ?? ''} ${j.status ?? ''}${j.scheduled_start ? `, ${when(j.scheduled_start)}` : ''} [id:${j.id}]`);
    }
  } else if (resource === 'leads') {
    push('Lead', `${d.lead_number ?? ''} ${d.status ?? ''} [id:${d.id}]`.trim());
    push('Customer', d.customer ? `${customerName(d.customer)} [id:${d.customer.id}]` : undefined);
    push('Request', truncate(d.service_request, 200));
    push('Owner', d.commission_owner ? `${d.commission_owner.first_name ?? ''} ${d.commission_owner.last_name ?? ''} [id:${d.commission_owner.id}]`.trim() : 'unassigned');
    const performers = Array.isArray(d.walkthrough_performers) ? d.walkthrough_performers : [];
    if (performers.length) push('Walkthrough performers', performers.map((p: Rec) => `${p.user?.first_name ?? ''} ${p.user?.last_name ?? ''}`.trim()).join(', '));
    push('Address', d.service_address_line1 ? `${d.service_address_line1}, ${d.service_city ?? ''} ${d.service_state ?? ''}` : undefined);
    // Walkthrough-as-entity redesign, PR-D2: walkthrough_needed is deleted - a lead is always in
    // the scheduling bucket until a visit is scheduled, so the "not scheduled yet" branch no
    // longer conditions on that removed flag.
    push('Walkthrough', d.walkthrough_scheduled_at ? when(d.walkthrough_scheduled_at) : 'not scheduled yet');
    const ests = Array.isArray(d.estimates) ? d.estimates : [];
    if (ests.length) {
      lines.push(`Estimates (${ests.length}):`);
      for (const e of ests.slice(0, 5)) lines.push(`• ${e.estimate_number ?? ''} ${e.status ?? ''} ${money(e.total_amount)} [id:${e.id}]`);
    }
    const tags = Array.isArray(d.tags) ? d.tags : [];
    if (tags.length) push('Tags', tags.map((t: Rec) => t.name ?? t.tag?.name).filter(Boolean).join(', '));
  } else if (resource === 'jobs') {
    push('Job', `${d.job_number ?? ''} ${d.status ?? ''} [id:${d.id}]`.trim());
    push('Customer', d.customer ? `${customerName(d.customer)} [id:${d.customer.id}]` : undefined);
    push('Scheduled', d.scheduled_start ? `${when(d.scheduled_start)}${d.scheduled_end ? ` → ${when(d.scheduled_end)}` : ''}` : 'not scheduled');
    const crew = Array.isArray(d.assignees) ? d.assignees : [];
    push('Crew', crew.length ? crew.map((a: Rec) => `${a.user?.first_name ?? ''} ${a.user?.last_name ?? ''} [id:${a.user?.id}]`.trim()).join(', ') : 'none');
    push('Location', d.service_location ? `${d.service_location.address_line1 ?? ''}, ${d.service_location.city ?? ''}` : undefined);
    push('Scope', truncate(d.scope_notes, 200));
    push('Estimate', d.estimate ? `${d.estimate.estimate_number ?? ''} (${money(d.estimate.total_amount)})` : undefined);
    push('Plan visit', d.source_plan ? `${d.source_plan.service_plan_number ?? ''} ${d.source_plan.name ?? ''} — NON-BILLABLE, the plan was paid upfront`.trim() : undefined);
  } else if (resource === 'estimates') {
    push('Estimate', `${d.estimate_number ?? ''} ${d.status ?? ''} [id:${d.id}]`.trim());
    push('Customer', d.lead?.customer ? customerName(d.lead.customer) : undefined);
    push('Lead', d.lead ? `${d.lead.lead_number ?? ''} [id:${d.lead.id ?? d.lead_id}]` : undefined);
    push('Total', money(d.total_amount));
    push('Sent', d.sent_at ? when(d.sent_at) : undefined);
    push('Valid until', d.valid_until ? whenDay(d.valid_until) : undefined);
    // The deposit rides as an embedded kind=DEPOSIT invoice.
    const dep = Array.isArray(d.invoices) ? d.invoices[0] : undefined;
    if (dep) {
      const paid = Array.isArray(dep.payments) && dep.payments.length > 0;
      push('Deposit', `${dep.status ?? ''} — ${money(dep.total_amount)}${paid ? ' (paid)' : Number(dep.amount_due) > 0 ? ` (due: ${money(dep.amount_due)})` : ''}`);
    }
    const items = Array.isArray(d.line_items) ? d.line_items : [];
    for (const li of items.slice(0, 8)) lines.push(`• ${truncate(li.description, 60)} ×${li.quantity} @ ${money(li.unit_price)}`);
  } else if (resource === 'invoices') {
    push('Invoice', `${d.invoice_number ?? ''} ${d.status ?? ''}${d.kind && d.kind !== 'STANDARD' ? ` (${d.kind})` : ''} [id:${d.id}]`.trim());
    push('Customer', customerName(d.job?.customer ?? d.customer));
    push('Job', d.job ? `${d.job.job_number ?? ''} [id:${d.job.id}]` : undefined);
    push('Total', money(d.total_amount));
    push('Due', money(d.amount_due));
    push('Due date', d.due_date ? whenDay(d.due_date) : undefined);
    push('Voided', d.voided_at ? `${when(d.voided_at)}${d.voided_reason ? ` — ${d.voided_reason}` : ''}` : undefined);
    const pays = Array.isArray(d.payments) ? d.payments : [];
    if (pays.length) {
      lines.push(`Payments (${pays.length}):`);
      for (const p of pays.slice(0, 6)) {
        const credit = p.reference_number === 'DEPOSIT-CREDIT' ? ' (deposit credit)' : '';
        lines.push(`• ${money(p.amount)} ${p.method ?? ''}${p.paid_at ? `, ${when(p.paid_at)}` : ''}${p.voided_at ? ' — VOIDED' : ''}${credit}`);
      }
    }
    const refunds = Array.isArray(d.refunds) ? d.refunds : [];
    if (refunds.length) push('Refunds', refunds.map((r: Rec) => money(r.amount)).join(', '));
    const credits = Array.isArray(d.credits) ? d.credits : [];
    if (credits.length) push('Credits', credits.map((c: Rec) => money(c.amount)).join(', '));
  } else {
    push('Record', `[id:${d.id}]`);
  }
  return lines.length ? lines.join('\n') : 'I could not load that record.';
}

function summarizeBriefing(d: Rec | undefined): string {
  if (!d) return 'I could not load the briefing.';
  const lines: string[] = [];
  const jt = d.kpis?.jobs_today;
  if (jt) lines.push(`Jobs today: ${jt.total ?? 0} (${jt.completed ?? 0} done, ${jt.scheduled ?? 0} scheduled).`);
  const rev = d.kpis?.revenue_mtd;
  if (rev) lines.push(`Collected MTD: ${money(rev.collected)} of ${money(rev.invoiced)} invoiced.`);
  const ar = d.kpis?.ar;
  if (ar) lines.push(`A/R outstanding: ${money(ar.total)}.`);
  const leads = d.kpis?.leads_open;
  if (leads) lines.push(`Open leads: ${leads.count ?? 0} (${leads.unassigned ?? 0} unassigned).`);
  const attention = Array.isArray(d.needs_attention) ? d.needs_attention : [];
  if (attention.length) {
    lines.push('Needs attention:');
    for (const a of attention.slice(0, 5)) lines.push(`• ${a.title ?? a.type}${a.meta ? ` — ${a.meta}` : ''}`);
  }
  return lines.length ? lines.join('\n') : 'Nothing notable right now.';
}

function customerName(c: Rec | undefined | null): string {
  if (!c) return 'the customer';
  if (c.company_name) return String(c.company_name);
  const n = [c.first_name, c.last_name].filter(Boolean).join(' ');
  return n || 'the customer';
}

function money(v: unknown): string {
  const n = Number(v ?? 0);
  return `$${(Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** Short human date-time for spoken summaries (e.g. "Wed, Jun 11, 9:00 AM"). */
function when(v: unknown): string {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v ?? '');
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// The `when` sibling for a value that is a calendar day and not an instant, so it is read in UTC.
// It carries no time of day, so the hour/minute of `when` are dropped: "Mon, Aug 3", not "Mon, Aug 3, 12:00 AM".
function whenDay(v: unknown): string {
  const out = formatExactDay(String(v), { weekday: 'short', month: 'short', day: 'numeric' });
  return out || String(v ?? '');
}

function truncate(v: unknown, max: number): string {
  const s = String(v ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function pick(args: Args, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined && args[k] !== null && args[k] !== '') out[k] = args[k];
  return out;
}

/** Drop undefined/null/empty so we never send keys the API would reject. */
function clean(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}
