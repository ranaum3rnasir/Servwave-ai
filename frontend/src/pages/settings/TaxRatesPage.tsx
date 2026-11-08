import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { useAppAbility } from '@/contexts/AbilityContext';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/hooks/useConfirm';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { Table } from '@/components/data/table';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { ConfirmRateChangeDialog } from '@/components/tax/ConfirmRateChangeDialog';
import { isImplausibleRateChange } from '@/components/tax/implausibleRateChange';
import {
  listOrgTaxRates,
  createOrgTaxRate,
  updateOrgTaxRate,
  deleteOrgTaxRate,
  type OrgTaxRate,
} from '@/lib/api/org-tax-rates';

const toPct = (rate: number | string) => Number(rate) * 100;
const fmtPct = (rate: number | string) => `${toPct(rate).toFixed(3)}%`;

/** A pending edit held back until the confirm dialog resolves. */
interface PendingEdit {
  id: string;
  name: string;
  ratePct: number;
  previousPct: number;
}

/**
 * Settings -> Tax Rates. The org's own tax list: it starts as a copy of the national combined
 * state rates with only the org's home state switched on, and the admin curates it from there.
 *
 * "Show in dropdown" is what the estimate/invoice/job tax pickers read, so an HVAC shop working
 * one state stops scrolling past 50 others. Hiding never changes tax on an existing document, and
 * never changes what an out-of-state job is taxed - derivation reads hidden rates too.
 */
export default function TaxRatesPage() {
  const ability = useAppAbility();
  const canEdit = ability.can('update', 'Organization');
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: rates, isLoading } = useQuery({
    queryKey: ['org-tax-rates'],
    queryFn: listOrgTaxRates,
    // A small reference list that only this page writes to. Without a staleTime, every return to
    // the page refetches and shows a spinner over rows we already have.
    staleTime: 5 * 60 * 1000,
  });

  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [newPct, setNewPct] = useState('');
  // Inline edit - click a row's fields to change them; commits on blur or Enter. `editField` is
  // which of the two the user actually clicked, so focus lands there rather than always on Name.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editField, setEditField] = useState<'name' | 'rate'>('name');
  const [editName, setEditName] = useState('');
  const [editPct, setEditPct] = useState('');
  const [pending, setPending] = useState<PendingEdit | null>(null);

  const invalidate = () => {
    // The settings list and the picker feed are separate queries off the same rows.
    queryClient.invalidateQueries({ queryKey: ['org-tax-rates'] });
    queryClient.invalidateQueries({ queryKey: ['state-tax-rates'] });
  };

  const createMutation = useMutation({
    mutationFn: () => createOrgTaxRate({ name: newName.trim(), rate: Number(newPct) / 100 }),
    onSuccess: () => {
      setNewName('');
      setNewPct('');
      invalidate();
    },
    onError: (err: unknown) =>
      toast({ title: 'Could not add rate', description: extractApiError(err, 'Failed to create tax rate'), variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; name: string; rate: number }) =>
      updateOrgTaxRate(vars.id, { name: vars.name, rate: vars.rate }),
    onSuccess: () => {
      setEditingId(null);
      setPending(null);
      invalidate();
    },
    onError: (err: unknown) => {
      toast({ title: 'Could not update rate', description: extractApiError(err, 'Failed to update tax rate'), variant: 'destructive' });
      setPending(null);
      invalidate(); // revert the optimistic-looking inline edit back to the server's last-known value
    },
  });

  // The visibility switch is its own mutation, applied optimistically. Curating a state list means
  // flipping a lot of switches in a row, and waiting out a round trip (plus a refetch of the whole
  // list) per flip makes the page feel broken on a slow connection. The cache holds the truth
  // until the server disagrees, so only the picker feed is invalidated here.
  const toggleMutation = useMutation({
    mutationFn: (vars: { id: string; is_visible: boolean }) =>
      updateOrgTaxRate(vars.id, { is_visible: vars.is_visible }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['org-tax-rates'] });
      const previous = queryClient.getQueryData<OrgTaxRate[]>(['org-tax-rates']);
      queryClient.setQueryData<OrgTaxRate[]>(['org-tax-rates'], (old) =>
        (old ?? []).map((r) => (r.id === vars.id ? { ...r, is_visible: vars.is_visible } : r)),
      );
      return { previous };
    },
    onError: (err: unknown, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(['org-tax-rates'], ctx.previous);
      toast({ title: 'Could not update rate', description: extractApiError(err, 'Failed to update tax rate'), variant: 'destructive' });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['state-tax-rates'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteOrgTaxRate(id),
    onSuccess: invalidate,
    onError: (err: unknown) =>
      toast({ title: 'Could not delete rate', description: extractApiError(err, 'Failed to delete tax rate'), variant: 'destructive' }),
  });

  const rows = useMemo(() => rates ?? [], [rates]);
  const visibleCount = rows.filter((r) => r.is_visible).length;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) => r.name.toLowerCase().includes(q) || (r.state_code ?? '').toLowerCase().includes(q),
    );
  }, [rows, search]);

  const startEdit = (r: OrgTaxRate, field: 'name' | 'rate') => {
    setEditingId(r.id);
    setEditField(field);
    setEditName(r.name);
    // toFixed, not String(): 0.0946 * 100 is 9.459999999999999 in binary floating point, and that
    // is what the user would otherwise find in the field they just clicked.
    setEditPct(toPct(r.rate).toFixed(3));
  };

  const commitEdit = (r: OrgTaxRate) => {
    const pct = Number(editPct);
    // Number('') is 0, not NaN -- an emptied field must not silently commit a 0% rate.
    if (!editName.trim() || editPct.trim() === '' || Number.isNaN(pct) || pct < 0 || pct > 100) {
      setEditingId(null);
      return;
    }
    const previousPct = toPct(r.rate);
    // Clicking into a row and back out is not an edit. Firing a PATCH plus a full refetch for it
    // is what makes the row appear to reload for no reason.
    const unchanged = editName.trim() === r.name && Math.abs(pct - previousPct) < 1e-9;
    if (unchanged) {
      setEditingId(null);
      return;
    }
    if (isImplausibleRateChange(pct, previousPct)) {
      setPending({ id: r.id, name: editName.trim(), ratePct: pct, previousPct });
      return;
    }
    updateMutation.mutate({ id: r.id, name: editName.trim(), rate: pct / 100 });
  };

  const newPctNum = Number(newPct);
  const canAdd =
    newName.trim().length > 0 &&
    newPct.trim() !== '' &&
    !Number.isNaN(newPctNum) &&
    newPctNum >= 0 &&
    newPctNum <= 100;

  return (
    <div className="space-y-6">
      <div>
        {/* `scale="lg"` because level 2 defaults to `sm`; the pair renders
            `text-lg font-semibold text-text-primary`, byte for byte the class
            string this h2 carried. */}
        <Heading level={2} scale="lg">Tax Rates</Heading>
        <p className="mt-0.5 text-sm text-text-secondary">
          Your organization&apos;s tax rates. Switch on the ones you actually bill in and they are the
          only rates offered on estimates, jobs and invoices. Editing a rate changes what new
          documents are taxed at - documents already sent keep the rate they were sent with.
        </p>
      </div>

      <Card>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tax rates"
                className="h-9 pl-9"
                aria-label="Search tax rates"
              />
            </div>
            <p className="text-xs text-text-secondary">
              {visibleCount} of {rows.length} shown in dropdowns
            </p>
          </div>

          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-text-secondary" />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={rows.length === 0 ? 'No tax rates yet' : 'No matching tax rates'}
              description={
                rows.length === 0
                  ? 'Add the rates you bill in and they will appear in every tax picker.'
                  : 'Try a different name or state code.'
              }
            />
          ) : (
            /* The design-system Table owns the scroll wrapper and the table's
               own base classes. `wrapper="x"` is the horizontal-only axis this
               table already had, and the base it applies is `w-full
               caption-bottom text-sm` - `caption-bottom` is inert with no
               <caption>, so this renders the identical box.

               The head/body cluster stays raw, deliberately. TableHead's three
               named variants are the three measured header signatures in the
               tree, and this header is a fourth: `compact` plus `font-medium`.
               There is no weight axis on TableHead, and expressing the weight
               with a className instead would add a soft appearance override at
               a call site - `layering-guard.test.ts` holds that count at 163
               with zero slack, so the honest options are a new prop on the
               primitive or leaving these cells raw. Left raw. */
            <Table wrapper="x">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                  <th className="pb-2 pr-3 font-medium">Name</th>
                  <th className="pb-2 pr-3 font-medium">Rate</th>
                  <th className="pb-2 pr-3 font-medium">Show in dropdown</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3">
                      {editingId === r.id ? (
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={() => commitEdit(r)}
                          onKeyDown={(e) => e.key === 'Enter' && commitEdit(r)}
                          className="h-8"
                          autoFocus={editField === 'name'}
                        />
                      ) : (
                        <button
                          type="button"
                          className="text-left font-medium text-text-primary disabled:cursor-default"
                          onClick={() => canEdit && startEdit(r, 'name')}
                          disabled={!canEdit}
                        >
                          {r.name}
                        </button>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {editingId === r.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            value={editPct}
                            onChange={(e) => setEditPct(e.target.value)}
                            onBlur={() => commitEdit(r)}
                            onKeyDown={(e) => e.key === 'Enter' && commitEdit(r)}
                            className="h-8 w-24"
                            autoFocus={editField === 'rate'}
                            min={0}
                            max={100}
                            step={0.001}
                          />
                          <span className="text-text-secondary">%</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="tabular-nums text-text-secondary disabled:cursor-default"
                          onClick={() => canEdit && startEdit(r, 'rate')}
                          disabled={!canEdit}
                        >
                          {fmtPct(r.rate)}
                        </button>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Switch
                        checked={r.is_visible}
                        disabled={!canEdit}
                        onCheckedChange={(next) => toggleMutation.mutate({ id: r.id, is_visible: next })}
                        aria-label={`Show ${r.name} in tax dropdowns`}
                      />
                    </td>
                    <td className="py-2 text-right">
                      {canEdit && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Remove the "${r.name}" tax rate?`,
                              description:
                                'Documents already taxed at this rate keep it. It just stops being offered.',
                              tone: 'danger',
                            });
                            if (ok) deleteMutation.mutate(r.id);
                          }}
                          disabled={deleteMutation.isPending}
                          aria-label={`Delete ${r.name}`}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}

          {canEdit && (
            <div className="flex items-end gap-2 border-t border-border pt-4">
              <div className="flex-1 space-y-1">
                <Label className="text-xs">Name</Label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Hoboken Combined"
                  className="h-9"
                />
              </div>
              <div className="w-28 space-y-1">
                <Label className="text-xs">Rate %</Label>
                <Input
                  type="number"
                  value={newPct}
                  onChange={(e) => setNewPct(e.target.value)}
                  min={0}
                  max={100}
                  step={0.001}
                  className="h-9"
                />
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={!canAdd || createMutation.isPending}
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Add rate
              </Button>
            </div>
          )}
        </div>
      </Card>

      {confirmDialog}

      <ConfirmRateChangeDialog
        open={pending !== null}
        name={pending?.name ?? ''}
        previousPct={pending?.previousPct}
        nextPct={pending?.ratePct ?? 0}
        onConfirm={() =>
          pending && updateMutation.mutate({ id: pending.id, name: pending.name, rate: pending.ratePct / 100 })
        }
        onCancel={() => {
          // Drop the edit rather than commit it - the field reverts to the stored value.
          setPending(null);
          setEditingId(null);
        }}
      />
    </div>
  );
}
