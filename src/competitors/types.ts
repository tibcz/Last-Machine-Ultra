/**
 * What it takes to be an entrant.
 *
 * There are two kinds and the difference is load-bearing. A `Competitor` is
 * given a brief and nothing else - it is structurally incapable of seeing an
 * answer, because the engine has no channel to hand it one. A
 * `SimulatedCompetitor` opts in to a second method that does receive the
 * canonical answers, which is how the built-in bots pretend to think without
 * anyone having to pay for tokens.
 *
 * Keeping them apart in the type system rather than in a flag means a live
 * adapter cannot accidentally end up on the cheating path.
 */

import type { Submission, YardBrief } from '../core/types.js';

export interface RunContext {
  /** Aborted at the cutoff. Adapters doing network calls must honour it. */
  signal: AbortSignal;
  /** Epoch ms at which the yard closes. */
  deadline: number;
  hour: number;
}

export interface Competitor {
  readonly id: string;
  readonly name: string;
  readonly team: string;
  readonly teamSlug: string;
  /** Adapter label for the dashboard: `local:pacer`, `http`, `anthropic`, ... */
  readonly kind: string;
  run(brief: YardBrief, ctx: RunContext): Promise<Submission>;
  close?(): Promise<void>;
}

export interface SimulatedCompetitor extends Competitor {
  readonly simulated: true;
  /**
   * @param solutions taskId -> the canonical answer.
   */
  runSimulated(
    brief: YardBrief,
    solutions: Readonly<Record<string, string>>,
    ctx: RunContext,
  ): Promise<Submission>;
}

export function isSimulated(competitor: Competitor): competitor is SimulatedCompetitor {
  return (competitor as SimulatedCompetitor).simulated === true;
}
