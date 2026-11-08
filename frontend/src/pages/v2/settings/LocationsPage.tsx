import { useEffect, useState } from 'react';

import {
  isBookableLocation,
  useLocations,
  useCreateLocation,
  useUpdateLocation,
  useDeleteLocation,
  useArchiveLocation,
  useUnarchiveLocation,
  type Location,
  type LocationInput,
} from '@/lib/api/locations';
import { extractApiError, formatPhone, formatPhoneInput } from '@/lib/utils';

import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Input } from '@/ui-kit/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { useSettingsBar } from './settingsBar';
import { Section, FlushCard } from './components/section';
import { Field } from './components/field';

const EMPTY: Partial<LocationInput> = { name: '', city: '', state: '', timezone: '', phone: '' };

/**
 * Settings > Locations.
 *
 * Delete has NO confirmation dialog, which diverges from every other
 * destructive action in this module. That is existing behaviour and it is
 * reproduced verbatim - adding a confirm here would be a behaviour change
 * smuggled into a restyle. Logged in the ledger instead.
 *
 * ARCHIVE / RESTORE (visit-location spec D9, slice 2). A location a visit points at cannot be
 * deleted - the foreign key restricts, because nulling the reference would silently move a booked
 * visit back to the customer's own address after they had been told to come here. Archiving is the
 * escape: the row stays alive so every trip already booked there keeps reading correctly, and it
 * leaves the booking picker so nobody books into a closed branch.
 *
 * DELETE STAYS BESIDE THEM, which is why this row carries two actions rather than a replacement.
 * A location nothing references - a typo, created and never used - should still be removable
 * outright; forcing an admin to archive it would leave permanent clutter in a list they cannot
 * tidy. The 409 the API answers when it IS referenced now names archiving as the way through, so
 * an admin who tries Delete first is told what to do rather than simply refused.
 *
 * ARCHIVED ROWS ARE SHOWN, NOT HIDDEN. Filtering this list would be the symmetric mistake to
 * forgetting the filter in the picker: it puts the yard closed last winter behind the only button
 * that can bring it back.
 */
export default function LocationsPage() {
  const { data: locations = [] } = useLocations();
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const remove = useDeleteLocation();
  const archive = useArchiveLocation();
  const unarchive = useUnarchiveLocation();
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

  // Build a clean payload from only the editable fields - never echo back
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
      // The API's 409 carries the whole story - every blocker in one sentence plus the pointer at
      // archiving - so it is surfaced verbatim. Swallowing it into the generic fallback would put
      // the dead end back one layer up.
      setError(extractApiError(e, 'Failed to delete location'));
    }
  };

  const setArchived = async (loc: Location, archived: boolean) => {
    setError(null);
    try {
      // "Restore" on the button, `unarchive` on the wire - the label is the spec's word, the
      // route matches the customer pair. Both halves are deliberate; see lib/api/locations.ts.
      await (archived ? archive : unarchive).mutateAsync(loc.id);
      // An archived location cannot be booked into, so leaving its edit card open would invite a
      // save against a row that is no longer offered anywhere.
      if (archived && editing?.id === loc.id) setEditing(null);
    } catch (e: unknown) {
      setError(extractApiError(e, archived ? 'Failed to archive location' : 'Failed to restore location'));
    }
  };

  const set = (k: keyof Location, v: string) => setEditing((p) => ({ ...p, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {/* role/aria-level rather than an <h3>: the raw-tag ratchet sits at its
            floor for h1-h6. */}
        <p role="heading" aria-level={3} className="text-sm font-semibold">
          Business Locations
        </p>
        <Button size="sm" onClick={startNew}>
          + New Location
        </Button>
      </div>

      {error && (
        <div className="bg-status-red-subtle text-status-red-emphasis rounded-md px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <FlushCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Branch</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Time Zone</TableHead>
              <TableHead className="w-20">Staff</TableHead>
              {/* Wide enough for the two actions this row now carries (Archive/Restore + Delete),
                  so neither wraps onto a second line at the narrowest settings width. */}
              <TableHead className="w-44" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} padding="none">
                  <EmptyState title="No locations yet." />
                </TableCell>
              </TableRow>
            )}
            {locations.map((loc) => (
              <TableRow
                key={loc.id}
                className="cursor-pointer"
                onClick={() =>
                  setEditing({ ...loc, phone: loc.phone == null ? loc.phone : formatPhone(loc.phone) })
                }
              >
                <TableCell>
                  {/* Shown, not hidden, and marked rather than merely dimmed: an admin scanning
                      this list for the branch they closed has to be able to tell which one it is,
                      and colour alone would not say so to everybody reading. */}
                  <span className={isBookableLocation(loc) ? 'font-medium' : 'font-medium text-muted-foreground'}>
                    {loc.name}
                  </span>
                  {!isBookableLocation(loc) && (
                    <span className="bg-muted text-muted-foreground ml-2 rounded px-1.5 py-0.5 text-xs">
                      Archived
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">
                    {[loc.address_line1, loc.city, loc.state].filter(Boolean).join(', ') || '-'}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">{loc.timezone || '-'}</span>
                </TableCell>
                <TableCell>{loc._count?.members ?? 0}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {/* One button, not two: archiving an archived branch is a no-op that reads
                        like a broken control, and a branch with no way back is exactly the
                        pressure that sends an admin to Delete instead. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        void setArchived(loc, isBookableLocation(loc));
                      }}
                    >
                      {isBookableLocation(loc) ? 'Archive' : 'Restore'}
                    </Button>
                    {/* Delete SURVIVES archiving. A location nothing references - a typo, never
                        used - is still removable outright, and the API's 409 is what redirects an
                        admin to Archive when it is referenced after all. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        void del(loc);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </FlushCard>

      {editing && (
        <Section title={editing.id ? 'Edit Branch' : 'New Branch'}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Branch Name" required>
              <Input value={editing.name ?? ''} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Street">
              <Input value={editing.address_line1 ?? ''} onChange={(e) => set('address_line1', e.target.value)} />
            </Field>
            <Field label="City">
              <Input value={editing.city ?? ''} onChange={(e) => set('city', e.target.value)} />
            </Field>
            <Field label="State">
              <Input value={editing.state ?? ''} onChange={(e) => set('state', e.target.value)} />
            </Field>
            <Field label="Time Zone">
              <Input value={editing.timezone ?? ''} onChange={(e) => set('timezone', e.target.value)} />
            </Field>
            <Field label="Phone">
              <Input value={editing.phone ?? ''} onChange={(e) => set('phone', formatPhoneInput(e.target.value))} />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!editing.name?.trim() || create.isPending || update.isPending}
            >
              {editing.id ? 'Save' : 'Create'}
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}
