/**
 * TaskCategoriesSettingsCard - the task categories manage panel in Settings > Payments & Lists,
 * beside the Tags card it is modelled on (visits-and-task-categories slice 09).
 *
 * The panel itself is shared: the admin-only "Categories" button on the Tasks page opens the same
 * TaskCategoryManager in a dialog. Like the Tags card these are real server rows, so edits save
 * immediately rather than through the shell's "Save Changes" bar.
 *
 * Rendered only when the viewer can create/update TaskCategory, which no defaultGrants row gives,
 * so it resolves to ADMIN-only via `manage all`.
 */
import { useState } from 'react';

import { AddTaskCategoryButton, TaskCategoryManager } from '@/components/tasks/TaskCategoryManager';

import { InfoPopover } from '../../_shared/infoPopover';
import { Section } from './section';

export function TaskCategoriesSettingsCard() {
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="Task categories"
      info={<InfoPopover label="Task categories">Changes save immediately.</InfoPopover>}
      action={<AddTaskCategoryButton onClick={() => setAdding(true)} />}
    >
      <TaskCategoryManager adding={adding} onAddingChange={setAdding} />
    </Section>
  );
}
