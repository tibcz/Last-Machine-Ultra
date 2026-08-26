/**
 * The race.
 *
 * The rules are the backyard ultra's rules, and they are short:
 *
 *   1. At the bell, everyone still in the corral starts the same yard.
 *   2. Solve every task before the cutoff and you are in for the next hour.
 *      Miss one task, or the cutoff, and you are out. There is no partial
 *      credit and there is no catching up.
 *   3. The winner is the last entrant to complete a yard, and must have
 *      completed one yard more than anyone else. When one entrant finishes a
 *      yard that the rest of the corral failed, that is already one more than
 *      any of them - so the race ends there and then. There is no extra lap.
 *   4. If every remaining entrant fails the same yard, nobody wins. That is a
 *      real result, not an error, and it is the reason the format is worth
 *      watching.
 *
 * Everyone except the winner records a DNF. The last entrant eliminated gets
 * the assist: the one who kept the winner honest.
 */

import { EventEmitter } from 'node:events';

import { briefFor, generateYard, solutionFor, verifyTask } from '../challenges/index.js';
import { isSimulated, type Competitor, type RunContext } from '../competitors/types.js';
import { InstantClock, type RaceClock } from './clock.js';
import { DEFAULT_RAMP, rulesForHour, type RampConfig } from './difficulty.js';
import type {
  EntrantState,
  OutReason,
  RaceSummary,
  Submission,
  TaskOutcome,
  TeamStanding,
  Yard,
  YardBrief,
  YardResult,
} from './types.js';

export interface RaceOptions {
  seed: string;
  competitors: Competitor[];
  clock?: RaceClock;
  ramp?: RampConfig;
  /** Safety stop. A race that reaches this hour ends with no winner declared. */
  maxHours?: number;
  /** Wall-clock ceiling on a simulated entrant, so a hung bot cannot stall a race. */
  simulatedTimeoutMs?: number;
  /** Wait for the first bell instead of starting immediately. */
  waitForFirstBell?: boolean;
}

export interface YardReport {
  hour: number;
  rules: Yard['rules'];
  decider: boolean;
  starters: number;
  finishers: string[];
  eliminated: string[];
  results: YardResult[];
}

/** Everything the engine emits. */
export interface RaceEvents {
  'race:start': { seed: string; entrants: EntrantState[]; clock: string };
  bell: { hour: number; brief: YardBrief; starters: EntrantState[] };
  'entrant:result': { entrant: EntrantState; result: YardResult };
  'entrant:out': { entrant: EntrantState; reason: OutReason; hour: number };
  'yard:end': YardReport;
  'race:end': RaceSummary;
}

export class Race {
  readonly seed: string;
  readonly clock: RaceClock;
  readonly ramp: RampConfig;
  readonly maxHours: number;

  #emitter = new EventEmitter();
  #competitors = new Map<string, Competitor>();
  #states = new Map<string, EntrantState>();
  #hour = 0;
  #status: RaceSummary['status'] = 'idle';
  #startedAt = 0;
  #finishedAt: number | undefined;
  #winnerId: string | undefined;
  #assistId: string | undefined;
  #noWinner = false;
  #ended = false;
  #reports: YardReport[] = [];
  readonly #simulatedTimeoutMs: number;
  readonly #waitForFirstBell: boolean;
  /** A solo race has no one to beat, so it can only ever be a time trial. */
  readonly timeTrial: boolean;

  constructor(options: RaceOptions) {
    if (options.competitors.length === 0) throw new Error('a race needs at least one entrant');

    this.seed = options.seed;
    this.clock = options.clock ?? new InstantClock();
    // The ramp's notion of an hour must match the clock's, or cutoffs stop
    // meaning anything.
    this.ramp = { ...(options.ramp ?? DEFAULT_RAMP), hourMs: this.clock.hourMs };
    this.maxHours = options.maxHours ?? 72;
    this.#simulatedTimeoutMs = options.simulatedTimeoutMs ?? 30_000;
    this.#waitForFirstBell = options.waitForFirstBell ?? false;
    this.timeTrial = options.competitors.length < 2;

    options.competitors.forEach((competitor, index) => {
      this.#competitors.set(competitor.id, competitor);
      this.#states.set(competitor.id, {
        id: competitor.id,
        bib: index + 1,
        name: competitor.name,
        team: competitor.team,
        teamSlug: competitor.teamSlug,
        kind: competitor.kind,
        status: 'in_corral',
        yards: 0,
        tasksSolved: 0,
        tasksAttempted: 0,
        totalElapsedMs: 0,
        totalTokens: 0,
      });
    });
  }

  on<K extends keyof RaceEvents>(event: K, listener: (payload: RaceEvents[K]) => void): this {
    this.#emitter.on(event, listener as (payload: unknown) => void);
    return this;
  }

  #emit<K extends keyof RaceEvents>(event: K, payload: RaceEvents[K]): void {
    this.#emitter.emit(event, payload);
  }

  get hour(): number {
    return this.#hour;
  }

  get reports(): readonly YardReport[] {
    return this.#reports;
  }

  get corral(): EntrantState[] {
    return [...this.#states.values()].filter((e) => e.status === 'in_corral');
  }

  get summary(): RaceSummary {
    const entrants = [...this.#states.values()].sort(
      (a, b) =>
        b.yards - a.yards ||
        b.tasksSolved - a.tasksSolved ||
        a.totalElapsedMs - b.totalElapsedMs ||
        a.bib - b.bib,
    );

    const summary: RaceSummary = {
      seed: this.seed,
      status: this.#status,
      hour: this.#hour,
      startedAt: this.#startedAt,
      noWinner: this.#noWinner,
      entrants,
      teams: standings(entrants, this.#winnerId),
    };
    if (this.#finishedAt !== undefined) summary.finishedAt = this.#finishedAt;
    const winner = this.#winnerId ? this.#states.get(this.#winnerId) : undefined;
    if (winner) summary.winner = winner;
    const assist = this.#assistId ? this.#states.get(this.#assistId) : undefined;
    if (assist) summary.assist = assist;
    return summary;
  }

  async run(): Promise<RaceSummary> {
    this.#status = 'running';
    this.#startedAt = Date.now();
    this.#emit('race:start', {
      seed: this.seed,
      entrants: [...this.#states.values()],
      clock: this.clock.label,
    });

    if (this.#waitForFirstBell) await this.clock.waitForBell();

    for (let hour = 1; hour <= this.maxHours; hour++) {
      if (hour > 1) await this.clock.waitForBell();
      this.#hour = hour;

      const starters = this.corral;
      if (starters.length === 0) break;

      const done = await this.#runYard(hour, starters);
      if (done) break;
    }

    if (!this.#ended) this.#finish();
    return this.summary;
  }

  /** @returns true when the race is over. */
  async #runYard(hour: number, starters: EntrantState[]): Promise<boolean> {
    const rules = rulesForHour(hour, this.ramp);
    // Two left means this yard can end it. Purely informational - the rules
    // below do not care how many started.
    const decider = starters.length === 2;
    const yard = generateYard(this.seed, rules, decider);
    const brief = briefFor(yard);

    const solutions: Record<string, string> = {};
    for (const task of yard.tasks) solutions[task.id] = solutionFor(task);

    this.#emit('bell', { hour, brief, starters });
    for (const entrant of starters) entrant.status = 'running';

    const results = await Promise.all(
      starters.map((entrant) => this.#runEntrant(entrant, yard, brief, solutions)),
    );

    const finishers: EntrantState[] = [];
    const eliminated: EntrantState[] = [];

    for (const result of results) {
      const entrant = this.#states.get(result.entrantId)!;
      entrant.tasksAttempted += result.outcomes.length;
      entrant.tasksSolved += result.outcomes.filter((o) => o.ok).length;
      entrant.totalElapsedMs += result.elapsedMs;
      entrant.totalTokens += result.tokensUsed;

      if (result.finished) {
        entrant.yards += 1;
        entrant.status = 'in_corral';
        finishers.push(entrant);
      } else {
        entrant.status = 'out';
        entrant.outAtHour = hour;
        entrant.outReason = result.outReason ?? 'wrong_answer';
        // Only explain the failure with a task when the task was the reason.
        // An entrant that ran past the cutoff is out for that, even if one of
        // its answers also happened to be wrong.
        const failed =
          entrant.outReason === 'wrong_answer'
            ? result.outcomes.find((o) => !o.ok)
            : undefined;
        entrant.lastNote = result.errorMessage ?? failed?.note ?? failed?.taskId;
        eliminated.push(entrant);
      }

      this.#emit('entrant:result', { entrant, result });
      if (!result.finished) {
        this.#emit('entrant:out', { entrant, reason: entrant.outReason!, hour });
      }
    }

    const report: YardReport = {
      hour,
      rules,
      decider,
      starters: starters.length,
      finishers: finishers.map((e) => e.id),
      eliminated: eliminated.map((e) => e.id),
      results,
    };
    this.#reports.push(report);
    this.#emit('yard:end', report);

    return this.#decide(finishers, eliminated, starters.length);
  }

  /** Apply the finishing rules. @returns true when the race is over. */
  #decide(finishers: EntrantState[], eliminated: EntrantState[], starters: number): boolean {
    if (finishers.length === 0) {
      // Everyone still in the race failed the same yard. No winner.
      this.#noWinner = true;
      this.#markAssist(eliminated);
      for (const entrant of eliminated) entrant.status = 'no_winner';
      this.#finish();
      return true;
    }

    // One finisher, and at least one other entrant started and failed: the
    // finisher now has a yard on the entire field, which is the win condition.
    if (finishers.length === 1 && starters > 1) {
      const winner = finishers[0]!;
      winner.status = 'winner';
      this.#winnerId = winner.id;
      this.#markAssist(eliminated);
      this.#finish();
      return true;
    }

    // A lone entrant has nobody to put a yard on, so a solo race is a time
    // trial: it simply runs until they fail, and nobody is declared winner.
    return false;
  }

  /** The runner-up: the strongest of the entrants knocked out this hour. */
  #markAssist(eliminated: EntrantState[]): void {
    const best = [...eliminated].sort(
      (a, b) =>
        b.yards - a.yards ||
        b.tasksSolved - a.tasksSolved ||
        a.totalElapsedMs - b.totalElapsedMs ||
        a.bib - b.bib,
    )[0];
    if (!best) return;
    if (this.#assistId) {
      const current = this.#states.get(this.#assistId);
      if (current && current.yards >= best.yards) return;
    }
    if (this.#assistId) {
      const previous = this.#states.get(this.#assistId);
      if (previous) previous.assist = false;
    }
    best.assist = true;
    this.#assistId = best.id;
  }

  #finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#status = 'finished';
    this.#finishedAt = Date.now();
    this.#emit('race:end', this.summary);
  }

  async #runEntrant(
    entrant: EntrantState,
    yard: Yard,
    brief: YardBrief,
    solutions: Record<string, string>,
  ): Promise<YardResult> {
    const competitor = this.#competitors.get(entrant.id)!;
    const cutoffMs = yard.rules.cutoffMs;

    // Live entrants are cut off at the cutoff. Simulated ones report their own
    // elapsed time, so they get a generous wall-clock leash instead - enough to
    // stop a hung bot, not enough to interfere with the simulation.
    const hardTimeoutMs = this.clock.simulated ? this.#simulatedTimeoutMs : cutoffMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hardTimeoutMs);
    const startedAt = Date.now();

    const ctx: RunContext = {
      signal: controller.signal,
      deadline: startedAt + hardTimeoutMs,
      hour: yard.hour,
    };

    let submission: Submission | undefined;
    let errorMessage: string | undefined;

    try {
      submission = isSimulated(competitor)
        ? await competitor.runSimulated(brief, solutions, ctx)
        : await competitor.run(brief, ctx);
    } catch (error) {
      errorMessage =
        controller.signal.aborted && !(error instanceof Error && error.message.includes('cutoff'))
          ? 'timed out'
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      clearTimeout(timer);
    }

    const measuredMs = Date.now() - startedAt;
    const elapsedMs = submission?.elapsedMs ?? measuredMs;
    const tokensUsed = submission?.tokensUsed ?? 0;

    const base: YardResult = {
      hour: yard.hour,
      entrantId: entrant.id,
      finished: false,
      elapsedMs,
      tokensUsed,
      outcomes: [],
    };

    if (errorMessage !== undefined) {
      return { ...base, outReason: errorMessage === 'timed out' ? 'missed_cutoff' : 'error', errorMessage };
    }
    if (!submission || typeof submission.answers !== 'object' || submission.answers === null) {
      return { ...base, outReason: 'no_submission' };
    }

    const outcomes: TaskOutcome[] = yard.tasks.map((task) => {
      const raw = submission!.answers[task.id] ?? '';
      const verdict = verifyTask(task, raw);
      const outcome: TaskOutcome = {
        taskId: task.id,
        family: task.family,
        ok: verdict.ok,
        expected: verdict.expected,
        got: verdict.got,
      };
      if (verdict.note) outcome.note = verdict.note;
      return outcome;
    });

    const late = elapsedMs > cutoffMs;
    const allCorrect = outcomes.every((o) => o.ok);

    const result: YardResult = { ...base, outcomes, finished: !late && allCorrect };
    if (late) result.outReason = 'missed_cutoff';
    else if (!allCorrect) result.outReason = 'wrong_answer';
    return result;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#competitors.values()].map((c) => c.close?.()));
  }
}

export function standings(entrants: EntrantState[], winnerId?: string): TeamStanding[] {
  const byTeam = new Map<string, TeamStanding>();
  for (const entrant of entrants) {
    const existing = byTeam.get(entrant.teamSlug) ?? {
      team: entrant.team,
      slug: entrant.teamSlug,
      bestYards: 0,
      entrants: 0,
      survivors: 0,
      won: false,
    };
    existing.entrants += 1;
    existing.bestYards = Math.max(existing.bestYards, entrant.yards);
    if (entrant.status === 'in_corral' || entrant.status === 'winner') existing.survivors += 1;
    if (winnerId && entrant.id === winnerId) existing.won = true;
    byTeam.set(entrant.teamSlug, existing);
  }
  return [...byTeam.values()].sort(
    (a, b) => Number(b.won) - Number(a.won) || b.bestYards - a.bestYards || a.team.localeCompare(b.team),
  );
}
