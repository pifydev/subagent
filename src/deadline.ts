/**
 * A wall-clock bound for one child run.
 *
 * The turn cap and the loop guard both act at message_end. A tool whose
 * execute() never resolves emits no message_end — so without a clock the run
 * is stranded for good, and with it the background slot it holds and any
 * parent blocking on it. This is the clock. Zero dependencies.
 */

/** True when `ms` elapsed before `work` settled; false when it settled first. A rejection of `work` propagates. */
export async function outlasts(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Wait for `work` to settle either way, but for at most `ms`. Never throws. */
export async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
