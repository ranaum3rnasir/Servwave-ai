import { useEffect, useState } from 'react';
import {
  useCustomFieldDefinitions,
  useCreateCustomFieldDefinition,
  useUpdateCustomFieldDefinition,
  type CustomFieldDefinition,
  type CustomFieldEntityType,
} from '@/lib/api/customFieldDefinitions';
import { extractApiError } from '@/lib/utils';
import { useSettingsBar } from './SettingsLayout';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/data/table';
import { EmptyState } from '@/components/ui/empty-state';
import { Pencil } from 'lucide-react';

// Only the entities that actually RENDER a field are offered. PRICE_BOOK_ITEM is a real
// CustomFieldEntity in the schema and the column exists on price_book_items, but nothing
// displays it until slice 5 - offering it here would let an admin tick a box, save with no
// error, and get a field that surfaces nowhere. A checkbox that silently does nothing is
// worse than a missing one, so this list widens when the surface ships, not before.
const ENTITY_OPTIONS: { value: CustomFieldEntityType; label: string }[] = [
  { value: 'LEAD', label: 'Leads' },
  { value: 'JOB', label: 'Jobs' },
  { value: 'CUSTOMER', label: 'Customers' },
];

const ENTITY_LABEL: Record<CustomFieldEntityType, string> = {
  LEAD: 'Lead',
  JOB: 'Job',
  CUSTOMER: 'Customer',
  PRICE_BOOK_ITEM: 'Price Book Item',
};

// Derives a stable key from the label so admins never hand-type a slug -
// lowercase, collapse runs of non a-z0-9 into one underscore, trim edges.
function deriveKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export default function CustomFieldsPage() {
  const { data: definitions = [] } = useCustomFieldDefinitions();
  const create = useCreateCustomFieldDefinition();
  const update = useUpdateCustomFieldDefinition();
  const { registerSaver } = useSettingsBar();

  // null = form closed. A string id = editing that definition. 'new' = creating one.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [entityTypes, setEntityTypes] = useState<CustomFieldEntityType[]>([]);
  const [error, setError] = useState<string | null>(null);

  const isCreating = editingId === 'new';
  const isSaving = create.isPending || update.isPending;

  // This screen manages its own create action; keep the sub-bar Save disabled.
  useEffect(() => {
    registerSaver({ save: () => {}, discard: () => {}, isDirty: false });
  }, [registerSaver]);

  const startNew = () => {
    setError(null);
    setLabel('');
    setEntityTypes([]);
    setEditingId('new');
  };

  const startEdit = (definition: CustomFieldDefinition) => {
    setError(null);
    setLabel(definition.label);
    // Carry the stored scope through verbatim, INCLUDING any entity no longer offered above
    // (a PRICE_BOOK_ITEM scope set before this list narrowed). The form only ever sends what
    // it holds, so an unrenderable scope is preserved rather than silently stripped on an
    // unrelated relabel.
    setEntityTypes(definition.entity_types);
    setEditingId(definition.id);
  };

  const cancel = () => {
    setEditingId(null);
    setError(null);
  };

  const toggleEntity = (value: CustomFieldEntityType) => {
    setEntityTypes((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  };

  const save = async () => {
    setError(null);
    try {
      if (isCreating) {
        await create.mutateAsync({
          key: deriveKey(label),
          label: label.trim(),
          type: 'TEXT',
          entity_types: entityTypes,
        });
      } else if (editingId) {
        // `key` is deliberately not re-derived from the edited label: stored values are keyed
        // by the definition's uuid, but the key is the org-facing identifier and the unique
        // constraint, so a relabel must not silently rename it. The API ignores it either way.
        await update.mutateAsync({ id: editingId, label: label.trim(), entity_types: entityTypes });
      }
      setEditingId(null);
    } catch (e: unknown) {
      setError(extractApiError(e, 'Failed to save custom field'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Heading level={3}>Custom Fields</Heading>
        <Button size="sm" onClick={startNew}>
          + New Field
        </Button>
      </div>

      {error && <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}

      <Card padding="none">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Entity Types</TableHead>
              <TableHead className="w-px" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {definitions.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} tone="muted" align="center">
                  <EmptyState title="No custom fields defined yet." />
                </TableCell>
              </TableRow>
            )}
            {definitions.map((def) => (
              <TableRow key={def.id}>
                <TableCell>
                  <div className="font-medium">{def.label}</div>
                </TableCell>
                <TableCell tone="muted">{def.key}</TableCell>
                <TableCell tone="muted">
                  {def.entity_types.map((t) => ENTITY_LABEL[t]).join(', ') || '-'}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${def.label}`}
                    onClick={() => startEdit(def)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {editingId && (
        <Card className="space-y-4">
          <Heading level={3}>{isCreating ? 'New Field' : 'Edit Field'}</Heading>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Label" required>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            {!isCreating && (
              <Field label="Key">
                {/* Read-only on purpose: the key is fixed at creation. Shown so an admin can
                    still see what automations and imports refer to this field by. */}
                <p className="pt-2 text-sm text-text-secondary">
                  {definitions.find((d) => d.id === editingId)?.key}
                </p>
              </Field>
            )}
          </div>
          <div className="space-y-1.5">
            <Label size="xs">Applies To</Label>
            <div className="flex flex-wrap gap-4">
              {ENTITY_OPTIONS.map((opt) => (
                <div key={opt.value} className="flex items-center gap-2">
                  <Checkbox
                    id={`entity-type-${opt.value}`}
                    checked={entityTypes.includes(opt.value)}
                    onCheckedChange={() => toggleEntity(opt.value)}
                  />
                  <Label htmlFor={`entity-type-${opt.value}`} tone="neutral" className="cursor-pointer">
                    {opt.label}
                  </Label>
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={!label.trim() || entityTypes.length === 0 || isSaving}
            >
              {isCreating ? 'Create' : 'Save'}
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
      <Label size="xs">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </Label>
      {children}
    </div>
  );
}
