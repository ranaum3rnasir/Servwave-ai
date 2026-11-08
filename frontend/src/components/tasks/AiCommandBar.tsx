import { useState, useMemo } from 'react';
import type { KeyboardEvent } from 'react';
import { Sparkles } from 'lucide-react';
import { taskAI, type ParsedTask } from '@/lib/tasks/taskAI';
import { useAssignableUsers } from '@/lib/api/users';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CreateTaskModal } from './CreateTaskModal';

export function AiCommandBar() {
  const [value, setValue] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [parsed, setParsed] = useState<ParsedTask | null>(null);

  // DEAD v1 (only importer is the unrouted pages/tasks/TasksHubPage). These names feed the
  // command bar's filter parsing, not an assignee field - `directory`, for consistency with the
  // live filter surfaces. Not invested in.
  const { data: rawUsers = [] } = useAssignableUsers({ purpose: 'directory', eligibleFor: 'task' });
  const people = useMemo(
    () => rawUsers.map((u) => ({
      id: u.id,
      name: `${u.first_name} ${u.last_name}`,
      role: u.role.toLowerCase(),
      department: u.department?.id ?? '',
    })),
    [rawUsers],
  );

  function handleSubmit() {
    const text = value.trim();
    if (!text) return;

    const result = taskAI.parse(text, { people, entities: [], now: new Date() });
    if (result.title) {
      setParsed(result);
      setModalOpen(true);
    }
    setValue('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') handleSubmit();
  }

  return (
    <>
      <div
        data-testid="tasks-ai-command"
        className="flex min-h-11 items-center gap-3 rounded-lg border border-primary/10 bg-primary-subtle/70 px-4 py-2.5 text-text-primary"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-light text-primary shadow-soft">
          <Sparkles className="h-4 w-4" />
        </span>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Ask anything or create a task — e.g. "remind Priya to order glass for the Limon job by Friday"'
          className="min-w-0 flex-1"
        />
        {value.trim() && (
          // solid/brand (default) matches bg-primary/text-on-fill/hover:bg-primary-dark
          // exactly. No exact size match: original had no explicit height (py-1.5 px-3,
          // text-xs) - nearest rung is 3xs (h-6/px-2/text-xs), disclosed.
          <Button type="button" onClick={handleSubmit} size="3xs" className="shrink-0">
            Go
          </Button>
        )}
      </div>

      <CreateTaskModal
        open={modalOpen}
        onOpenChange={(v) => {
          setModalOpen(v);
          if (!v) setParsed(null);
        }}
        initialParse={parsed}
      />
    </>
  );
}
