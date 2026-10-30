import { Paperclip } from 'lucide-react';

import { useOpenEmailAttachment } from '@/lib/api/communication';
import type { Attachment } from '@/lib/api/communication';
import { Button } from '@/ui-kit/components/ui/button';

const CHIP = 'text-muted-foreground inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-[13px]';

/**
 * One attached file on an email message. The one chip every email screen uses: a file the server stored (it has an
 * `index`) is a button that opens it in a new tab; anything else (a file added in this compose session, or an old
 * entry that was only ever a name) stays a plain label, because there is nothing to open.
 */
export function EmailAttachmentChip({
  emailId, attachment, onToast,
}: {
  emailId: string;
  attachment: Attachment;
  onToast: (message: string) => void;
}) {
  const { name, size, index } = attachment;
  if (typeof index !== 'number') {
    return (
      <span className={CHIP}>
        <Paperclip className="size-4 flex-none" aria-hidden />
        <span className="min-w-0 truncate">{name}</span>
        <span className="flex-none">· {size}</span>
      </span>
    );
  }
  return <OpenableChip emailId={emailId} index={index} name={name} size={size} onToast={onToast} />;
}

function OpenableChip({
  emailId, index, name, size, onToast,
}: {
  emailId: string;
  index: number;
  name: string;
  size: string;
  onToast: (message: string) => void;
}) {
  const { open, state } = useOpenEmailAttachment(emailId, index, onToast);
  if (state === 'hidden') return null;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="max-w-full text-[13px]"
        aria-label={`Open ${name}`}
        isLoading={state === 'opening'}
        onClick={open}
      >
        {state !== 'opening' && <Paperclip aria-hidden />}
        <span className="min-w-0 truncate">{name}</span>
        <span className="text-muted-foreground flex-none font-normal">· {size}</span>
      </Button>
      {state === 'failed' && (
        <>
          <span role="status" className="text-muted-foreground text-[12px]">Could not open the file.</span>
          <Button type="button" variant="ghost" size="sm" aria-label={`Retry opening ${name}`} onClick={open}>
            Retry
          </Button>
        </>
      )}
    </span>
  );
}
