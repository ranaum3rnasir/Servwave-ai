/**
 * The Files field of both New Task dialogs (visits-and-task-categories slice 13).
 *
 * Two faces, one component, driven by `useTaskCreateFiles`:
 *  - while the form is a draft: a drop zone with a keyboard-reachable Browse button, the queued
 *    files (each removable), and any pick refused before it was queued;
 *  - once the task exists: each file's progress and outcome, a Retry on any that failed, and one
 *    line saying which files did not make it. The task is created either way.
 *
 * Kit-neutral on purpose (`components/ui` + `UploadSelectionList`), so the Tasks page dialog and
 * the legacy entity-tab modal render the same thing.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UploadRefusalList, UploadSelectionList } from '@/components/attachments/UploadSelectionList';
import type { TaskCreateFiles } from '@/lib/tasks/useTaskCreateFiles';
import { ACCEPTED_UPLOAD_TYPES } from '@/lib/uploadTypes';
import { cn } from '@/lib/utils';

function fileWord(n: number): string {
  return n === 1 ? 'file' : 'files';
}

/** One sentence on where the files stand, once the task exists. */
function AfterCreateStatus({ files }: { files: TaskCreateFiles }) {
  if (files.uploading) {
    return <p role="status" className="text-sm text-text-secondary">Task created. Uploading files…</p>;
  }
  if (files.failed.length > 0) {
    const names = files.failed.map((i) => `"${i.file.name}"`).join(', ');
    return (
      <p role="alert" className="text-sm text-danger">
        Task created, but {files.failed.length} {fileWord(files.failed.length)} didn't upload: {names}.
        Retry below, or add {files.failed.length === 1 ? 'it' : 'them'} later from the task.
      </p>
    );
  }
  const done = files.items.filter((i) => i.status === 'done').length;
  const cancelled = files.items.filter((i) => i.status === 'cancelled').length;
  return (
    <p role="status" className="text-sm text-text-secondary">
      Task created with {done} {fileWord(done)}.
      {cancelled > 0 && ` ${cancelled} cancelled - retry below if you still want ${cancelled === 1 ? 'it' : 'them'}.`}
    </p>
  );
}

export function TaskCreateFilesField({ files }: { files: TaskCreateFiles }) {
  const labelId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const created = files.taskId !== null;

  // The Files field sits at the foot of a long form, so on a phone a refusal lands below the
  // fold and the pick looks like it silently did nothing. Bring the first one into view.
  const refusalsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (files.refusals.length === 0) return;
    refusalsRef.current?.querySelector('[role="alert"]')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [files.refusals]);

  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-text-primary">Files</span>

      {created ? (
        <AfterCreateStatus files={files} />
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            files.add(e.dataTransfer.files);
          }}
          className={cn(
            'flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-text-secondary transition-colors',
            dragOver ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          <Paperclip className="h-4 w-4 shrink-0" aria-hidden />
          <span>Drop files here, or</span>
          <Button
            type="button"
            variant="outline"
            size="3xs"
            aria-describedby={labelId}
            onClick={() => inputRef.current?.click()}
          >
            Browse
          </Button>
          <Input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPTED_UPLOAD_TYPES}
            aria-label="Files to attach"
            tabIndex={-1}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) files.add(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      )}

      <div ref={refusalsRef} className="empty:hidden">
        <UploadRefusalList messages={files.refusals} />
      </div>
      <UploadSelectionList
        items={files.items}
        onRemove={created ? undefined : files.remove}
        onCancel={created ? files.cancel : undefined}
        onRetry={created ? (key) => void files.retry(key) : undefined}
        retryDisabled={files.uploading}
      />
    </div>
  );
}
