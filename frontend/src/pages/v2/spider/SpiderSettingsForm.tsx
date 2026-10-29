import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { spiderErrorText } from '@/lib/spider/errorText';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';
import { Input } from '@/ui-kit/components/ui/input';
import { Switch } from '@/ui-kit/components/ui/switch';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Label } from '@/ui-kit/components/ui/label';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { toast } from '@/ui-kit/components/ui/sonner';
import { useUsers } from '@/lib/api/users';
import {
  useSaveSpiderSettings,
  useSpiderSettings,
  type SpiderChannels,
  type SpiderLeadLabel,
  type SpiderRole,
  type SpiderSettings,
  type SpiderSettingsResponse,
  type SpiderSettingsInput,
} from '@/lib/api/spider';

const CHANNELS: { key: keyof SpiderChannels; label: string; hint: string }[] = [
  { key: 'in_app', label: 'In-app popup', hint: 'A card in ServWave for each alert.' },
  { key: 'red_frame', label: 'Red frame', hint: 'A red frame around the app while an in-app alert is unread. Needs the in-app popup.' },
  { key: 'email', label: 'Email', hint: 'From "ServWave Spider Alerts".' },
  { key: 'text', label: 'Text message', hint: 'To staff phone numbers only, never to customers.' },
];

function toInput(s: SpiderSettings): SpiderSettingsInput {
  return {
    status_limits: s.status_limits,
    channels: s.channels,
    recipients: s.recipients,
    watch_all_leads: s.watch_all_leads,
    selected_lead_ids: s.selected_lead_ids,
  };
}

/** Whether two versions of the form hold the same settings. */
function sameInput(a: SpiderSettingsInput, b: SpiderSettingsInput): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The lead labels the server sent with its copy, by lead id. */
function labelsOf(data: SpiderSettingsResponse): Record<string, SpiderLeadLabel> {
  return Object.fromEntries(data.selected_leads.map((l) => [l.id, l]));
}

const SAVE_FAILED = 'Could not save Spider settings.';

/** The save error as the sentences the server wrote, never a field name (see spiderErrorText). */
export function saveErrorText(err: unknown, statusLabels: Record<string, string> = {}): string {
  return spiderErrorText(err, SAVE_FAILED, statusLabels);
}

/**
 * Spider's settings (#2619), loaded from and saved to the server - the only copy there is. Only
 * shown while Spider is on (SpiderPage). It has no on/off switch of its own: the page's switch,
 * the same one as in the AI Agentic Farm, is the only way to turn Spider on or off, and saving
 * here never changes it.
 */
export function SpiderSettingsForm({ onUnsavedChange }: { onUnsavedChange?: (unsaved: boolean) => void } = {}) {
  const settingsQuery = useSpiderSettings();
  const save = useSaveSpiderSettings();
  const [form, setForm] = useState<SpiderSettingsInput | null>(null);
  const [leadLabels, setLeadLabels] = useState<Record<string, SpiderLeadLabel>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Take the server's copy whenever a fresh one arrives (first load, and a refetch), unless the
  // form holds edits not saved yet: a background refetch never overwrites what the Admin is typing
  // (the page keeps the form mounted behind History, so a draft can outlive several refetches).
  // The edits are then measured against the newer copy. A save takes the server's answer itself
  // (onSave). Done while rendering, keyed on the response object, rather than in an effect.
  const [syncedFrom, setSyncedFrom] = useState<SpiderSettingsResponse | undefined>(undefined);
  if (settingsQuery.data && settingsQuery.data !== syncedFrom) {
    const data = settingsQuery.data;
    const editing = !!form && !!syncedFrom && !sameInput(form, toInput(syncedFrom.settings));
    setSyncedFrom(data);
    if (editing) {
      // Keep the labels of leads the draft picked that the server does not know yet.
      setLeadLabels((m) => ({ ...m, ...labelsOf(data) }));
    } else {
      setForm(toInput(data.settings));
      setLeadLabels(labelsOf(data));
    }
  }

  // Whether the form differs from the server's copy, for the page's switch: turning Spider off
  // locks the page and throws these changes away, so it asks first (SpiderPage).
  const unsaved = !!form && !!syncedFrom && !sameInput(form, toInput(syncedFrom.settings));
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-10" role="status">
        <Spinner />
        <span className="text-sm text-text-secondary">Loading Spider settings…</span>
      </div>
    );
  }
  if (settingsQuery.isError || !settingsQuery.data || !form) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-6">
          <p role="alert" className="text-sm text-danger-text">
            {extractApiError(settingsQuery.error, 'Could not load Spider settings.')}
          </p>
          <Button variant="outline" onClick={() => settingsQuery.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { options } = settingsQuery.data;
  const statusLabels = Object.fromEntries(options.statuses.map((o) => [o.value, o.label]));
  const update = (patch: Partial<SpiderSettingsInput>) => {
    setSavedAt(null);
    save.reset();
    setForm((f) => (f ? { ...f, ...patch } : f));
  };
  const onSave = () => {
    setSavedAt(null);
    save.mutate(form, {
      onSuccess: (data, sent) => {
        // The saved copy is the form from now on, whatever the server made of it. An edit made
        // while the save was on its way is kept, still unsaved.
        setSyncedFrom(data);
        setForm((f) => (f && !sameInput(f, sent) ? f : toInput(data.settings)));
        setLeadLabels((m) => ({ ...m, ...labelsOf(data) }));
        setSavedAt(Date.now());
        toast.success('Spider settings saved');
      },
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle level={2}>Statuses to watch</CardTitle>
          <CardDescription>
            Spider checks your open leads every few minutes and alerts your team once a lead has stayed in a status
            longer than its limit. Time is counted from the moment a lead entered its current status, never from before
            Spider was switched on. Each lead alerts once per visit to a status.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {options.statuses.map((status) => {
            const limit = form.status_limits[status.value];
            const setLimit = (patch: Partial<typeof limit>) =>
              update({ status_limits: { ...form.status_limits, [status.value]: { ...limit, ...patch } } });
            return (
              <div key={status.value} className="flex flex-wrap items-center gap-3">
                <Switch
                  checked={limit.enabled}
                  onCheckedChange={(v) => setLimit({ enabled: v })}
                  aria-label={`Watch ${status.label}`}
                />
                <span className="w-48 text-sm font-medium text-text-primary">{status.label}</span>
                <span className="text-sm text-text-secondary">alert after</span>
                <Input
                  type="text"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  className="w-20"
                  value={Number.isFinite(limit.value) ? String(limit.value) : ''}
                  onChange={(e) => setLimit({ value: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
                  aria-label={`Time limit for ${status.label}`}
                  disabled={!limit.enabled}
                />
                <SelectField
                  className="w-32"
                  options={options.units}
                  value={limit.unit}
                  onValueChange={(unit) => setLimit({ unit })}
                  aria-label={`Time unit for ${status.label}`}
                  disabled={!limit.enabled}
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle level={2}>How to alert</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {CHANNELS.map((c) => (
            <div key={c.key} className="flex items-start gap-3">
              <Switch
                checked={form.channels[c.key]}
                onCheckedChange={(v) => update({ channels: { ...form.channels, [c.key]: v } })}
                aria-label={c.label}
                disabled={c.key === 'red_frame' && !form.channels.in_app}
              />
              <div className="flex flex-col">
                <span className="text-sm font-medium text-text-primary">{c.label}</span>
                <span className="text-xs text-text-secondary">{c.hint}</span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <RecipientsCard
        roles={options.roles}
        value={form.recipients}
        onChange={(recipients) => update({ recipients })}
      />

      <LeadsCard
        watchAll={form.watch_all_leads}
        selected={form.selected_lead_ids}
        labels={leadLabels}
        onChange={(watch_all_leads, selected_lead_ids, label) => {
          if (label) setLeadLabels((m) => ({ ...m, [label.id]: label }));
          update({ watch_all_leads, selected_lead_ids });
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onSave} isLoading={save.isPending}>
          Save settings
        </Button>
        {save.isError && (
          <p role="alert" className="text-sm text-danger-text">
            {saveErrorText(save.error, statusLabels)}
          </p>
        )}
        {savedAt && !save.isError && <span className="text-sm text-text-secondary">Saved</span>}
      </div>
    </div>
  );
}

function RecipientsCard({
  roles,
  value,
  onChange,
}: {
  roles: { value: SpiderRole; label: string }[];
  value: SpiderSettingsInput['recipients'];
  onChange: (v: SpiderSettingsInput['recipients']) => void;
}) {
  const users = useUsers();
  const people = useMemo(
    () => (users.data ?? []).filter((u) => u.is_active !== false),
    [users.data],
  );
  const nameOf = (id: string) => {
    const u = people.find((p) => p.id === id);
    return u ? `${u.first_name} ${u.last_name}`.trim() : 'Team member';
  };
  const toggleRole = (role: SpiderRole, on: boolean) =>
    onChange({ ...value, roles: on ? [...value.roles, role] : value.roles.filter((r) => r !== role) });
  const nothingChosen = value.roles.length === 0 && value.user_ids.length === 0 && !value.lead_owner;

  return (
    <Card>
      <CardHeader>
        <CardTitle level={2}>Who to alert</CardTitle>
        <CardDescription>
          The same people get the popup, the email and the text, and only people who can open the lead. If nobody is
          chosen, your Admins are alerted. If nobody you chose can be reached for a lead, Admins get the alert.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          {roles.map((r) => (
            <div key={r.value} className="flex items-center gap-2">
              <Checkbox
                id={`spider-role-${r.value}`}
                checked={value.roles.includes(r.value)}
                onCheckedChange={(v) => toggleRole(r.value, v === true)}
              />
              <Label htmlFor={`spider-role-${r.value}`}>Everyone in {r.label}</Label>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="spider-lead-owner"
            checked={value.lead_owner}
            onCheckedChange={(v) => onChange({ ...value, lead_owner: v === true })}
          />
          <Label htmlFor="spider-lead-owner">The lead&apos;s owner</Label>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-text-primary">Specific people</span>
          <SelectField
            className="max-w-sm"
            options={people
              .filter((p) => !value.user_ids.includes(p.id))
              .map((p) => ({ value: p.id, label: `${p.first_name} ${p.last_name}`.trim() }))}
            value=""
            placeholder={users.isLoading ? 'Loading people…' : 'Add a person'}
            onValueChange={(id) => id && onChange({ ...value, user_ids: [...value.user_ids, id] })}
            aria-label="Add a person to alert"
          />
          {value.user_ids.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {value.user_ids.map((id) => (
                <li key={id} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm">
                  {nameOf(id)}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${nameOf(id)}`}
                    onClick={() => onChange({ ...value, user_ids: value.user_ids.filter((u) => u !== id) })}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {nothingChosen && <p className="text-xs text-text-secondary">Nobody chosen: your Admins will be alerted.</p>}
      </CardContent>
    </Card>
  );
}

interface LeadSearchRow {
  id: string;
  lead_number: string;
  customer?: { first_name?: string | null; last_name?: string | null; company_name?: string | null } | null;
}

function LeadsCard({
  watchAll,
  selected,
  labels,
  onChange,
}: {
  watchAll: boolean;
  selected: string[];
  labels: Record<string, SpiderLeadLabel>;
  onChange: (watchAll: boolean, selected: string[], label?: SpiderLeadLabel) => void;
}) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const q = debounced.trim();
  const search = useQuery<SpiderLeadLabel[]>({
    queryKey: ['spider', 'lead-search', q],
    enabled: !watchAll && q.length >= 2,
    queryFn: () =>
      api.get('/api/leads', { params: { search: q, limit: 8 } }).then((r) =>
        ((r.data?.leads ?? []) as LeadSearchRow[]).map((l) => ({
          id: l.id,
          lead_number: l.lead_number,
          customer_name:
            `${l.customer?.first_name ?? ''} ${l.customer?.last_name ?? ''}`.trim() || l.customer?.company_name || 'Customer',
        })),
      ),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle level={2}>Which leads</CardTitle>
        <CardDescription>Won, Lost and Cancelled leads are never watched.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Switch
            id="spider-watch-all"
            checked={watchAll}
            onCheckedChange={(v) => onChange(v, selected)}
            aria-label="Watch all open leads"
          />
          <Label htmlFor="spider-watch-all">Watch all open leads</Label>
        </div>
        {!watchAll && (
          <div className="flex flex-col gap-2">
            <SearchInput
              className="max-w-sm"
              value={term}
              onValueChange={setTerm}
              onDebouncedChange={setDebounced}
              placeholder="Find a lead by number or customer"
              aria-label="Find a lead to watch"
            />
            {(search.data ?? [])
              .filter((l) => !selected.includes(l.id))
              .map((l) => (
                <div key={l.id} className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-xs">{l.lead_number}</span>
                  <span className="text-text-secondary">{l.customer_name}</span>
                  <Button variant="outline" size="sm" onClick={() => onChange(false, [...selected, l.id], l)}>
                    Watch
                  </Button>
                </div>
              ))}
            {selected.length === 0 ? (
              <p className="text-xs text-text-secondary">No leads picked yet: Spider watches nothing until you add one.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {selected.map((id) => {
                  const label = labels[id];
                  const text = label ? `${label.lead_number} · ${label.customer_name}` : 'Lead';
                  return (
                    <li key={id} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm">
                      {text}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Stop watching ${text}`}
                        onClick={() => onChange(false, selected.filter((s) => s !== id))}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

