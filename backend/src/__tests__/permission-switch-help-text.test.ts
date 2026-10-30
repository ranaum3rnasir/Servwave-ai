/* =============================================================================
   Roles & Permissions, PRD 2, slice S02.1 - the help text the editor shows beside a switch says what the PRD needs.

   Pure: no database. The phrases below are the PRD's wording written out as literals (stories 24, 25, 31 and 32 and
   the alert-duty lines); the editor shows the catalog's text verbatim, so this is where the words are held.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { findSwitch } from '../lib/permissions/switches/catalog';

const help = (key: string) => findSwitch(key)!.helpText;

describe('the help text of the switches PRD 2 words', () => {
  it('says See costs covers costs only and prices always follow the record', () => {
    expect(help('see_costs')).toMatch(/cost/i);
    expect(help('see_costs')).toMatch(/prices/i);
  });

  it('keeps Create customers to the standalone New Customer and names what it excludes', () => {
    const text = help('create_customers');
    expect(text).toMatch(/standalone/i);
    expect(text).toMatch(/lead/i);
    expect(text).toMatch(/job/i);
    expect(text).toMatch(/service plan/i);
  });

  it('says Edit and Delete on estimates and invoices apply to the records in scope, with no exception for who made them (P7)', () => {
    for (const key of ['edit_estimates', 'delete_estimates', 'edit_invoices', 'delete_invoices']) {
      expect(help(key), key).toMatch(/in scope/i);
      expect(help(key), key).not.toMatch(/creator|other people/i);
    }
  });

  it('says each Assign switch covers every people field, the creator\'s pre-fill included, and who is alerted to act', () => {
    for (const key of ['assign_people_to_jobs', 'assign_people_to_leads']) {
      expect(help(key), key).toMatch(/every people field/i);
      expect(help(key), key).toMatch(/pre-?fill/i);
    }
    expect(help('assign_people_to_leads')).toMatch(/walkthrough/i);
    expect(help('assign_people_to_leads')).toMatch(/Book walkthroughs/);
    expect(help('assign_people_to_leads')).toMatch(/no owner/i);
    expect(help('assign_people_to_jobs')).toMatch(/schedule/i);
  });

  it('says what each eligibility switch pre-fills on the create form', () => {
    expect(help('can_own_leads')).toMatch(/pre-?filled as (the )?Owner/i);
    expect(help('can_own_leads')).toMatch(/Sold By/);
    expect(help('can_be_dispatcher')).toMatch(/pre-?filled as (the )?Dispatcher/i);
    expect(help('can_be_dispatcher')).toMatch(/Can own leads/);
    expect(help('can_be_on_crew')).toMatch(/crew/i);
  });

  it('names the alert duty of the switches that make their holder the person who must act', () => {
    expect(help('office_review')).toMatch(/alert/i);
    expect(help('access_billing')).toMatch(/alert/i);
    expect(help('access_billing')).toMatch(/payment/i);
    expect(help('assign_people_to_leads')).toMatch(/alert/i);
    expect(help('assign_people_to_jobs')).toMatch(/alert/i);
  });

  it('says what each "Alert me about every ..." switch sends on top of the normal recipients', () => {
    for (const key of ['alert_every_job', 'alert_every_lead', 'alert_every_estimate', 'alert_every_invoice']) {
      expect(help(key), key).toMatch(/copy of every/i);
      expect(help(key), key).toMatch(/on top of/i);
    }
  });

  it('words Attach conversations, Reopen leads, Complete jobs and Start and finish visits', () => {
    expect(help('attach_conversations')).toMatch(/call, text or email/i);
    expect(help('reopen_leads')).toMatch(/Won/);
    expect(help('reopen_leads')).toMatch(/Lost/);
    expect(help('reopen_leads')).not.toMatch(/cancel/i);
    expect(help('complete_jobs')).toMatch(/whole job/i);
    expect(help('complete_jobs')).toMatch(/only action/i);
    expect(help('complete_jobs')).toMatch(/office review/i);
    expect(help('start_and_finish_visits')).toMatch(/never changes the job/i);
  });
});
