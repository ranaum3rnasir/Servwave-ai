import NotAuthorizedPage from '@/components/NotAuthorizedPage';
import { useAppAbility } from '@/contexts/AbilityContext';

import { ListCard } from './lists/ListCard';
import { useJobTypeList } from './lists/useJobTypeList';
import { useLeadSourceList } from './lists/useLeadSourceList';
import { useTagList } from './lists/useTagList';
import { useTaskCategoryList } from './lists/useTaskCategoryList';

function JobTypesCard() {
  return <ListCard controller={useJobTypeList()} />;
}

function LeadSourcesCard() {
  return <ListCard controller={useLeadSourceList()} />;
}

export function TagsCard() {
  return <ListCard controller={useTagList()} />;
}

export function TaskCategoriesCard() {
  return <ListCard controller={useTaskCategoryList()} />;
}

/**
 * Settings > Lists (spec 6): stacked cards, each exactly eight rows tall, every change saved on its own with an Undo.
 * The page registers no saver with the settings shell, so the shell's Save bar stays hidden. A typed URL from someone
 * who may not change company settings lands on the no-access page, not on a form whose loads would all be refused.
 */
export default function ListsPage() {
  const ability = useAppAbility();
  if (!ability.can('update', 'Organization')) return <NotAuthorizedPage />;
  // `update`/`delete Tag` carry no defaultGrants row, so this is ADMIN-only.
  const canManageTags = ability.can('update', 'Tag') && ability.can('delete', 'Tag');
  // `create`/`update TaskCategory` carry no defaultGrants row either: ADMIN-only.
  const canManageTaskCategories = ability.can('create', 'TaskCategory') && ability.can('update', 'TaskCategory');
  return (
    <div className="lc-grid">
      <JobTypesCard />
      <LeadSourcesCard />
      {canManageTags && <TagsCard />}
      {canManageTaskCategories && <TaskCategoriesCard />}
    </div>
  );
}
