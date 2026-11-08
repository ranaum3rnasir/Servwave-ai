import { useState } from 'react';
import { Settings2, Plus, Trash2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  useGeofenceConfig,
  useCreateStore,
  useUpdateStore,
  useDeleteStore,
  useUpdateGeofenceConfig,
} from '@/lib/api/timeclock';
import { StoreLocationPicker, type StoreDraft } from './StoreLocationPicker';

const BLANK: StoreDraft = { label: '', address: '', lat: 40.7128, lng: -74.006 };
const clampRadius = (n: number) => Math.min(300, Math.max(50, n));

export function GeofenceSettingsDialog() {
  const { data: config } = useGeofenceConfig();
  const createStore = useCreateStore();
  const updateStore = useUpdateStore();
  const deleteStore = useDeleteStore();
  const updateConfig = useUpdateGeofenceConfig();

  const stores = config?.stores ?? [];
  const radiusM = config?.radiusM ?? 150;

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // store id, 'new', or null (list view)
  const [draft, setDraft] = useState<StoreDraft>(BLANK);

  const startAdd = () => {
    setDraft(BLANK);
    setEditingId('new');
  };
  const startEdit = (id: string) => {
    const s = stores.find((x) => x.id === id);
    if (s) {
      // Stores persist only label/lat/lng; address is a transient search aid.
      setDraft({ label: s.label, address: '', lat: s.lat, lng: s.lng });
      setEditingId(id);
    }
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft(BLANK);
  };
  const saveDraft = async () => {
    if (draft.label.trim() === '' || !Number.isFinite(draft.lat) || !Number.isFinite(draft.lng)) return;
    const payload = { label: draft.label.trim(), lat: draft.lat, lng: draft.lng };
    if (editingId === 'new') await createStore.mutateAsync(payload);
    else if (editingId) await updateStore.mutateAsync({ id: editingId, payload });
    cancelEdit();
  };

  const saving = createStore.isPending || updateStore.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) cancelEdit();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Settings2 className="h-4 w-4" /> Geofence settings
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Geofence settings</DialogTitle>
          <DialogDescription>
            Add the stores your technicians clock in at. They can clock in at any store here, or at a job
            site they're assigned to.
          </DialogDescription>
        </DialogHeader>

        {editingId === null ? (
          <div className="space-y-4">
            <ul className="space-y-2">
              {stores.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-text-primary">{s.label}</div>
                    <div className="truncate text-xs text-text-secondary">
                      {`${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}`}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      tone="subtle"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="Edit store"
                      onClick={() => startEdit(s.id)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      tone="danger"
                      size="icon"
                      className="h-7 w-7"
                      disabled={stores.length <= 1 || deleteStore.isPending}
                      aria-label="Remove store"
                      onClick={() => void deleteStore.mutateAsync(s.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            <Button variant="outline" size="sm" className="gap-1.5" onClick={startAdd}>
              <Plus className="h-4 w-4" /> Add store
            </Button>

            {/* Wrapping label around a type="range" slider - not a FormField-shape site (label
                wraps its control), and the Input primitive's box styling (border/background/
                padding) is shaped for a text field, not a native slider track/thumb - both left
                raw, same reasoning as this program's checkbox/radio deferrals. */}
            <label className="block text-sm">
              <span className="mb-1 block text-text-secondary">Clock-in radius: {radiusM} m</span>
              <input
                type="range"
                min={50}
                max={300}
                step={10}
                value={radiusM}
                onChange={(e) => void updateConfig.mutateAsync(clampRadius(Number(e.target.value)))}
                className="w-full"
              />
            </label>

            <div className="flex justify-end">
              <Button onClick={() => setOpen(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <StoreLocationPicker key={editingId} value={draft} onChange={setDraft} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={cancelEdit}>
                Cancel
              </Button>
              <Button onClick={() => void saveDraft()} disabled={saving}>
                {editingId === 'new' ? 'Add store' : 'Save store'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default GeofenceSettingsDialog;
