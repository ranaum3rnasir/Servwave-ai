import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { extractApiError } from '@/lib/utils';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormField } from '@/components/patterns/FormField';
import { useDepartments } from '@/lib/api/departments';
import {
  useInviteUser,
  useUpdateUser,
  type UserRow,
} from '@/lib/api/users';
import { useRoles, roleAssignmentOptions, resolveRoleAssignment } from '@/lib/api/roles';

const formSchema = z.object({
  first_name: z.string().min(1, 'Required').max(100),
  last_name: z.string().min(1, 'Required').max(100),
  email: z.string().email('Invalid email'),
  // A system role name or a custom role's key - resolveRoleAssignment (lib/api/roles)
  // maps this back to the real {role, custom_role_id} pair at submit time.
  role: z.string().min(1),
  department_id: z.string().nullable(),
});

type FormValues = z.infer<typeof formSchema>;

interface StaffFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  initial?: UserRow | null;
}

export function StaffFormDialog({ open, onOpenChange, mode, initial }: StaffFormDialogProps) {
  const { data: depts = [] } = useDepartments();
  const { data: roles = [] } = useRoles();
  const inviteUser = useInviteUser();
  const updateUser = useUpdateUser();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      first_name: '',
      last_name: '',
      email: '',
      role: 'TECHNICIAN',
      department_id: null,
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      first_name: initial?.first_name ?? '',
      last_name: initial?.last_name ?? '',
      email: initial?.email ?? '',
      role: initial?.custom_role?.key ?? initial?.role ?? 'TECHNICIAN',
      department_id: initial?.department_id ?? null,
    });
  }, [open, initial, form]);

  const isEdit = mode === 'edit';
  const pending = inviteUser.isPending || updateUser.isPending;

  const onSubmit = async (values: FormValues) => {
    const { role, custom_role_id } = resolveRoleAssignment(roles, values.role);
    try {
      if (isEdit && initial) {
        await updateUser.mutateAsync({
          id: initial.id,
          payload: {
            first_name: values.first_name,
            last_name: values.last_name,
            role: role as UserRow['role'],
            custom_role_id,
            department_id: values.department_id,
          },
        });
      } else {
        await inviteUser.mutateAsync({ ...values, role: role as UserRow['role'], custom_role_id });
      }
      onOpenChange(false);
    } catch (err) {
      const axiosErr = err as { response?: { status?: number; data?: { error?: string } } };
      if (axiosErr.response?.status === 409) {
        form.setError('email', { message: 'This email is already in use.' });
      } else {
        form.setError('root', {
          message: extractApiError(err, 'Something went wrong'),
        });
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Staff' : 'Invite User'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update user details.'
              : "They'll get an email to set a password — or they can sign in with Google using this address."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="First name" error={form.formState.errors.first_name?.message}>
              <Input {...form.register('first_name')} />
            </FormField>
            <FormField label="Last name" error={form.formState.errors.last_name?.message}>
              <Input {...form.register('last_name')} />
            </FormField>
          </div>

          <FormField label="Email" error={form.formState.errors.email?.message}>
            <Input type="email" {...form.register('email')} disabled={isEdit} />
          </FormField>

          {/* Select is a Radix root that renders no DOM of its own, so the id has to
              land on the trigger button - FormField's render-prop child exists for
              exactly this shape (a compound control cloneElement cannot shape-fit). */}
          <FormField label="Role">
            {(fieldProps) => (
              <Select
                value={form.watch('role')}
                onValueChange={(v) => form.setValue('role', v)}
              >
                <SelectTrigger {...fieldProps}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roleAssignmentOptions(roles).map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          <FormField label="Department">
            {(fieldProps) => (
              <Select
                value={form.watch('department_id') ?? '__none__'}
                onValueChange={(v) => form.setValue('department_id', v === '__none__' ? null : v)}
              >
                <SelectTrigger {...fieldProps}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No department</SelectItem>
                  {depts.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          {form.formState.errors.root && (
            <p className="text-sm text-danger">{form.formState.errors.root.message}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? 'Save' : 'Send invite'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
