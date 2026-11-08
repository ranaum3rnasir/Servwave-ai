import { useEffect, useState } from 'react';
import {
  useLocations,
  useCreateLocation,
  useUpdateLocation,
  useDeleteLocation,
  type Location,
  type LocationInput,
} from '@/lib/api/locations';
import { extractApiError, formatPhone, formatPhoneInput } from '@/lib/utils';
import { useSettingsBar } from './SettingsLayout';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/data/table';
import { EmptyState } from '@/components/ui/empty-state';

const EMPTY: Partial<LocationInput> = { name: '', city: '', state: '', timezone: '', phone: '' };

export default function LocationsPage() {
  const { data: locations = [] } = useLocations();
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const remove = useDeleteLocation();
  const { registerSaver } = useSettingsBar();

  const [editing, setEditing] = useState<Partial<Location> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // This screen manages its own per-row saves; keep the sub-bar Save disabled.
  useEffect(() => {
    registerSaver({ save: () => {}, discard: () => {}, isDirty: false });
  }, [registerSaver]);

  const startNew = () => {
    setError(null);
    setEditing({ ...EMPTY });
  };

  // Build a clean payload from only the editable fields — never echo back
  // server-controlled keys (id/created_at/manager/_count). Code and manager were
  // removed from this screen, so they are no longer sent.
  const buildPayload = (e: Partial<Location>): Partial<LocationInput> => ({
    name: e.name,
    address_line1: e.address_line1 ?? null,
    city: e.city ?? null,
    state: e.state ?? null,
    timezone: e.timezone ?? null,
    phone: e.phone ?? null,
  });

  const save = async () => {
    if (!editing) return;
    setError(null);
    try {
      const payload = buildPayload(editing);
      if (editing.id) {
        await update.mutateAsync({ id: editing.id, ...payload });
      } else {
        await create.mutateAsync(payload);
      }
      setEditing(null);
    } catch (e: unknown) {
      setError(extractApiError(e, 'Failed to save location'));
    }
  };

  const del = async (loc: Location) => {
    setError(null);
    try {
      await remove.mutateAsync(loc.id);
      if (editing?.id === loc.id) setEditing(null);
    } catch (e: unknown) {
      setError(extractApiError(e, 'Failed to delete location'));
    }
  };

  const set = (k: keyof Location, v: string) => setEditing((p) => ({ ...p, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Heading level={3}>Business Locations</Heading>
        <Button size="sm" onClick={startNew}>
          + New Location
        </Button>
      </div>

      {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

      <Card padding="none">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Branch</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Time Zone</TableHead>
              <TableHead className="w-20">Staff</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} tone="muted" align="center">
                  <EmptyState title="No locations yet." />
                </TableCell>
              </TableRow>
            )}
            {locations.map((loc) => (
              <TableRow
                key={loc.id}
                className="cursor-pointer"
                onClick={() => setEditing({ ...loc, phone: loc.phone == null ? loc.phone : formatPhone(loc.phone) })}
              >
                <TableCell>
                  <div className="font-medium">{loc.name}</div>
                </TableCell>
                <TableCell tone="muted">
                  {[loc.address_line1, loc.city, loc.state].filter(Boolean).join(', ') || '—'}
                </TableCell>
                <TableCell tone="muted">{loc.timezone || '—'}</TableCell>
                <TableCell>{loc._count?.members ?? 0}</TableCell>
                <TableCell>
                  <Button
                    variant="ghost" tone="danger"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void del(loc);
                    }}
                  >
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {editing && (
        <Card className="space-y-4">
          <Heading level={3}>{editing.id ? 'Edit Branch' : 'New Branch'}</Heading>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Branch Name" required><Input value={editing.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label="Street"><Input value={editing.address_line1 ?? ''} onChange={(e) => set('address_line1', e.target.value)} /></Field>
            <Field label="City"><Input value={editing.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Field>
            <Field label="State"><Input value={editing.state ?? ''} onChange={(e) => set('state', e.target.value)} /></Field>
            <Field label="Time Zone"><Input value={editing.timezone ?? ''} onChange={(e) => set('timezone', e.target.value)} /></Field>
            <Field label="Phone"><Input value={editing.phone ?? ''} onChange={(e) => set('phone', formatPhoneInput(e.target.value))} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={!editing.name?.trim() || create.isPending || update.isPending}>
              {editing.id ? 'Save' : 'Create'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </Label>
      {children}
    </div>
  );
}
