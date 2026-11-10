/* =============================================================================
   #3016 entry-point guard: every place in the backend that sends a text, and where its destination comes from.

   A text a PERSON sends anchored on a lead or a job goes where the record says (lib/communication/recordTextDestination.ts,
   proven over HTTP in anchored-text-destination-db.test.ts). An automated text keeps the customer record's own number
   (4 October Q34), so the automation sender must not read the record's number. A staff alert texts a staff member's phone,
   never a customer's.

   This walks the source for every file that hands a text to the phone system, and each must be in the table below. A new
   sender fails here until it is classified.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Handing a text to the phone system, or checking one before it is handed over. */
const SENDS_A_TEXT = /\b(sendCtmSms|precheckCtmSms|sendStaffAlertSms)\s*\(/;

const SENDERS: Record<string, 'PERSON_ANCHORED_FROM_RECORD' | 'AUTOMATION_CUSTOMER_NUMBER' | 'STAFF_ALERT' | 'DEFINITION'> = {
  // POST /api/communication/sms: the inbox, the customer page, and the lead and job Communication tabs.
  'controllers/comm-threads.controller.ts': 'PERSON_ANCHORED_FROM_RECORD',
  'services/automations/smsRecord.ts': 'AUTOMATION_CUSTOMER_NUMBER',
  'services/spider/delivery.ts': 'STAFF_ALERT',
  'lib/ctm/sendSms.ts': 'DEFINITION',
};

const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe('every place that sends a text, and where its destination comes from', () => {
  it('is classified in the table', () => {
    const senders = sourceFiles(SRC)
      .filter((file) => SENDS_A_TEXT.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split('\\').join('/'))
      .sort();
    expect(senders).toEqual(Object.keys(SENDERS).sort());
  });

  it('a send a person anchors on a lead or a job takes its destination from the record', () => {
    expect(read('controllers/comm-threads.controller.ts')).toMatch(/recordTextDestination\(/);
  });

  it("an automated text and a staff alert never read a lead's or job's number", () => {
    for (const [file, use] of Object.entries(SENDERS)) {
      if (use === 'AUTOMATION_CUSTOMER_NUMBER' || use === 'STAFF_ALERT') {
        expect(read(file), file).not.toMatch(/recordTextDestination|recordContactEntry|record-contact-entries/);
      }
    }
  });
});
