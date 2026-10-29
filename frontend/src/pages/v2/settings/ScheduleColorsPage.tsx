/**
 * Settings > Schedule Colors - the colour each event type takes on the scheduler board, per
 * organization. Its own page (owner, 2026-09-15) rather than a block on Company Profile.
 *
 * Follows the InventorySettingsPage skeleton: react-hook-form + dirty-only PATCH through the
 * shared settings Save bar (useSettingsBar().registerSaver). The one field is
 * `schedule_event_colors`, a partial map of event type to design-system token name - see
 * design-system/scheduleEventPalette.ts for what may be chosen and lib/schedule/eventColors.ts
 * for how the board resolves it.
 */
import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';

import { useOrganization, useUpdateOrganization, type OrgFormValues } from '@/lib/api/organization';

import { useSettingsBar } from './settingsBar';
import { Section } from './components/section';
import { EventColorsCard } from './components/eventColorsCard';
import { ScheduleColorsPreview } from './components/scheduleColorsPreview';

type FormValues = Pick<OrgFormValues, 'schedule_event_colors'>;

export default function ScheduleColorsPage() {
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const { registerSaver } = useSettingsBar();

  const form = useForm<FormValues>({ defaultValues: { schedule_event_colors: {} } });
  const { reset, watch, setValue, getValues, formState } = form;

  // Hydrate once per org, and never over an edit in progress - the guard every settings page
  // carries, for the reason spelled out on InventorySettingsPage.
  const hydratedOrgId = useRef<string | null>(null);

  useEffect(() => {
    const identityChanged = hydratedOrgId.current !== org?.id;
    if (!identityChanged && formState.isDirty) return;
    if (org) {
      hydratedOrgId.current = org.id;
      reset({ schedule_event_colors: org.schedule_event_colors ?? {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, reset]);

  const isDirty = formState.isDirty;

  useEffect(() => {
    registerSaver({
      save: async () => {
        const values = getValues();
        // The one field is the whole payload: the map is written as a unit, so a Reset (a
        // deleted key) reaches the server as the map WITHOUT that key.
        if (formState.dirtyFields.schedule_event_colors) {
          await update.mutateAsync({ schedule_event_colors: values.schedule_event_colors });
        }
        reset(values);
      },
      discard: () => {
        if (org) reset();
      },
      isDirty,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  // The draft, saved or not: the picker and the preview read the same value, so the preview shows
  // what the board WILL paint once this is saved.
  const draft = watch('schedule_event_colors') ?? {};

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Section
        title="Event types"
        description="The colour each type of event takes on the schedule board. Completed and in-progress jobs keep their own colours so you can still tell at a glance what is done."
      >
        <EventColorsCard
          value={draft}
          onChange={(next) => setValue('schedule_event_colors', next, { shouldDirty: true })}
        />
      </Section>
      {/* Beside the picker on a wide screen, and held in view while the admin scrolls the rows. */}
      <ScheduleColorsPreview colors={draft} className="lg:sticky lg:top-4" />
    </div>
  );
}
