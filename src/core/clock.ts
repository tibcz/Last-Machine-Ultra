/**
 * When the bell rings.
 *
 * A real race rings on the hour, for hours. That is unwatchable to develop
 * against and unrunnable in CI, so the clock is an interface with three
 * implementations: the real thing, a compressed one that treats N milliseconds
 * as an hour, and an instant one that never waits at all.
 *
 * Under an instant clock, wall time is meaningless, so entrants report their
 * own elapsed time and the engine marks the cutoff against that instead.
 */

export interface RaceClock {
  /** How long an hour is, in milliseconds. Drives the whole ramp. */
  readonly hourMs: number;
  /** True when elapsed time comes from submissions rather than the wall. */
  readonly simulated: boolean;
  readonly label: string;
  now(): number;
  /** Milliseconds until the next bell. */
  msUntilBell(): number;
  /** Resolves at the next bell. */
  waitForBell(signal?: AbortSignal): Promise<void>;
}

const HOUR = 3_600_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error('aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The real thing: bells land on wall-clock hour boundaries. */
export class WallClock implements RaceClock {
  readonly hourMs = HOUR;
  readonly simulated = false;
  readonly label = 'wall clock, on the hour';

  now(): number {
    return Date.now();
  }

  msUntilBell(): number {
    const now = this.now();
    return HOUR - (now % HOUR);
  }

  waitForBell(signal?: AbortSignal): Promise<void> {
    return sleep(this.msUntilBell(), signal);
  }
}

/** An hour is `hourMs` milliseconds. Good for a race you can watch over lunch. */
export class CompressedClock implements RaceClock {
  readonly simulated = false;
  readonly label: string;
  #next: number;

  constructor(readonly hourMs: number) {
    if (hourMs < 200) throw new RangeError('hourMs must be at least 200ms');
    this.#next = Date.now();
    this.label = `compressed, 1 hour = ${hourMs}ms`;
  }

  now(): number {
    return Date.now();
  }

  msUntilBell(): number {
    return Math.max(0, this.#next - this.now());
  }

  async waitForBell(signal?: AbortSignal): Promise<void> {
    await sleep(this.msUntilBell(), signal);
    // Advance from the scheduled time, not from now, so a slow yard does not
    // push every later bell late.
    this.#next = Math.max(this.now(), this.#next) + this.hourMs;
  }
}

/**
 * No waiting at all. The hour still "lasts" `hourMs` as far as the ramp is
 * concerned - that is what keeps cutoffs meaningful - but nothing sleeps.
 */
export class InstantClock implements RaceClock {
  readonly simulated = true;
  readonly label: string;
  #virtualNow = 0;

  constructor(readonly hourMs: number = HOUR) {
    this.label = `instant, 1 hour = ${hourMs}ms of simulated time`;
  }

  now(): number {
    return this.#virtualNow;
  }

  msUntilBell(): number {
    return 0;
  }

  async waitForBell(): Promise<void> {
    this.#virtualNow += this.hourMs;
  }
}
