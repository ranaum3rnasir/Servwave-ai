import { FormField } from '@/components/patterns/FormField';
import { SelectField } from '@/components/form/SelectField';
import { Textarea } from '@/components/ui/textarea';
import { useOfferedJobCancelReasons } from '@/lib/api/jobCancelReasons';

interface CancelReasonFieldsProps {
  code: string;
  onCodeChange: (code: string) => void;
  note: string;
  onNoteChange: (note: string) => void;
  /** The reason covers several jobs: the placeholder asks in the plural. */
  many?: boolean;
}

/**
 * The reason a job is cancelled with (Roles & Permissions, S06.15), shared by the single cancel dialog and the Jobs list
 * bulk cancel dialog: a REQUIRED reason picked from the company's active job cancel-reasons list, and an optional note.
 *
 * The picker is the design system's select, which turns into a searchable list once a company has ten or more reasons, so
 * a long list is searched, never a wall. There is no free-text way round it: the server refuses a cancel whose reason is
 * not on the list.
 */
export function CancelReasonFields({ code, onCodeChange, note, onNoteChange, many = false }: CancelReasonFieldsProps) {
  const { options, loading } = useOfferedJobCancelReasons();
  return (
    <>
      {/* Render prop, not a plain child: the trigger is the labelable control and takes the generated id (the decline
          estimate dialog does the same). */}
      <FormField label="Reason *">
        {(fieldProps) => (
          <SelectField
            {...fieldProps}
            value={code}
            onValueChange={onCodeChange}
            placeholder={loading ? 'Loading reasons...' : many ? 'Why are these jobs being cancelled?' : 'Why is this job being cancelled?'}
            options={options}
            disabled={loading}
          />
        )}
      </FormField>
      <FormField label="Note (optional)">
        <Textarea
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          rows={3}
          placeholder="Anything the team should know"
        />
      </FormField>
    </>
  );
}
