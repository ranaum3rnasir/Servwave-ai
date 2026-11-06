/* =============================================================================
   Test helper (not a test file): one Spider sweep in its OWN process, the way the server's scheduler starts it
   (index.ts: scheduleJob -> runOnJobsClient -> runSpiderSweep), so a test can stop the process for real (SIGKILL) while
   the sweep is part way through a company's starting summary, and then run the sweep again.

     node --import tsx support/spider-sweep-child.ts <ISO time to run the sweep at>

   It reads the same DATABASE_URL the server would, and the server's other required settings from its environment (the
   parent test passes them). It has no email or phone provider key, so even a run that is not stopped could send nothing.
   Prints the sweep's result as one JSON line when it finishes.
   ========================================================================== */

import { runOnJobsClient } from '../../lib/prismaJobs';
import { runSpiderSweep } from '../../services/spider/sweep';

const at = new Date(process.argv[2] ?? '');
if (Number.isNaN(at.getTime())) throw new Error('usage: spider-sweep-child.ts <ISO time>');

void runOnJobsClient(() => runSpiderSweep(at)).then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  },
  () => process.exit(1),
);
