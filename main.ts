// Forge entrypoint: the handshake between the make.fun harness and the forge.
//
// The harness owns the trial. This process only has to do four things, in
// order, and then get out of the way:
//   1. listen on an ephemeral port,
//   2. hand that port to the harness (register),
//   3. wait until the harness reports the trial finished (done),
//   4. shut the server down and leave with status 0.
//
// Traffic, storage, and the whole GitHub surface live in app.ts. This file
// only runs the lifecycle the harness expects.

import { createApp } from './app.ts';

// Where the harness lives. Trailing slashes are stripped so joining a path
// onto it never produces a double slash.
const HARNESS_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (HARNESS_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is missing: no harness to talk to\n');
  process.exit(1);
}

// One harness call may take this long before it is abandoned and retried.
const CALL_BUDGET_MS = 30_000;
// Retry waits start at this many milliseconds and grow to this ceiling.
const BACKOFF_START_MS = 250;
const BACKOFF_LIMIT_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((resume) => setTimeout(resume, ms));

// Wait before the next retry after `failures` failed attempts: exponential
// growth from BACKOFF_START_MS, capped at BACKOFF_LIMIT_MS.
function backoffFor(failures: number): number {
  return Math.min(BACKOFF_LIMIT_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

// Keep calling `step` until it reports success, pausing longer after each
// failure. `step` returns true when its work is finished and false when it
// should run again; a thrown error escapes at once.
async function retryUntil(step: (attempt: number) => Promise<boolean>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (await step(attempt)) return;
    await pause(backoffFor(attempt));
  }
}

// Announce the bound port to the harness. A 200 means the harness recorded
// it; a 409 means another entry registered first, which is equally fine —
// this process just keeps waiting like any other. A 400 or 405 is a contract
// error and aborts the run; anything else (network error, odd status, the
// harness still booting) is retried.
async function announcePort(port: number): Promise<void> {
  await retryUntil(async () => {
    try {
      const response = await fetch(`${HARNESS_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (response.status === 200 || response.status === 409) return true;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`harness refused the port (HTTP ${response.status}): ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('harness refused the port')) throw error;
    }
    return false;
  });
}

// Ask the harness whether the trial is over, until it says yes. A missing
// or slow answer is not a failure — it only means "not done yet".
async function awaitCompletion(): Promise<void> {
  await retryUntil(async () => {
    try {
      const response = await fetch(`${HARNESS_ORIGIN}/done`, {
        signal: AbortSignal.timeout(CALL_BUDGET_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) return true;
      }
    } catch {
      // Harness unreachable or the call timed out: keep polling.
    }
    return false;
  });
}

// The whole life of this process: build the forge, bind a port, announce
// it, wait for the harness to finish the trial, then shut down cleanly.
async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => resolve());
  });
  const bound = forge.address();
  if (bound === null) throw new Error('the forge did not bind an ephemeral TCP port');
  const { port } = bound;
  process.stdout.write(`[entry] forge listening on port ${port}\n`);

  await announcePort(port);
  process.stdout.write('[entry] port announced; waiting for the harness to finish\n');

  await awaitCompletion();
  forge.close();
  process.stdout.write('[entry] trial done, shutting down\n');
}

run().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
