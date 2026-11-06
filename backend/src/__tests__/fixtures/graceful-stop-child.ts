/**
 * A stand-in server for graceful-stop.test.ts (#2991): installs the real stop handler, keeps running like a server, and
 * prints READY. Its "work in progress" is chosen by argv[2]:
 * - `finishes`: work that ends 500 ms after the signal, printing FINISHED;
 * - `hangs`: work that never ends;
 * - `idle`: no work at all.
 * argv[3] is the handler's longest wait, in ms.
 */
import { installStopSignals, stopRequested } from '../../lib/graceful-stop';

const mode = process.argv[2] ?? 'idle';
const maxWaitMs = Number(process.argv[3] ?? 5000);

let work: Promise<void> = Promise.resolve();
const finishing = async () => {
  if (mode === 'finishes') {
    work = new Promise<void>((resolve) =>
      setTimeout(() => {
        process.stdout.write(`FINISHED stopRequested=${stopRequested()}\n`);
        resolve();
      }, 500),
    );
  } else if (mode === 'hangs') {
    work = new Promise<void>(() => undefined);
  }
  await work;
};

installStopSignals({ finishing, maxWaitMs });
setInterval(() => undefined, 1000);
process.stdout.write('READY\n');
