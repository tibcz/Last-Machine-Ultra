/**
 * The vocabulary of the race.
 *
 * Terms are borrowed from backyard ultras, because the format is:
 *
 *   yard     one hour's loop. You either complete it or you are done.
 *   bell     the start of a yard. Everyone starts together, on the hour.
 *   corral   the entrants still in the race.
 *   cutoff   the deadline for the yard. Late is the same as wrong.
 *   DNF      did not finish. Everybody gets one, except the winner.
 */

/** The challenge families a yard can draw from. */
export const FAMILIES = [
  'modchain',
  'sequence',
  'cipher',
  'spec',
  'pathfind',
  'knights',
  'needle',
  'knapsack',
  'latin',
  'ultrasm',
] as const;

export type Family = (typeof FAMILIES)[number];

/**
 * Hazards are the format's version of fatigue. They do not make the maths
 * harder, they make the yard harder to survive: less framing, more noise,
 * stricter output.
 */
export const HAZARDS = ['terse', 'decoys', 'no_scratch', 'blind', 'midnight'] as const;
export type Hazard = (typeof HAZARDS)[number];

export const HAZARD_BLURB: Record<Hazard, string> = {
  terse: 'Briefs lose their framing. Work out what is being asked.',
  decoys: 'Plausible, wrong data is mixed into every task.',
  no_scratch: 'Answers only. Any reasoning in the output is a DNF.',
  blind: 'The answer format is no longer stated. Infer it.',
  midnight: 'Every task is pinned at maximum tier, and the yard is one task longer.',
};

/** A task as the entrant sees it. */
export interface PublicTask {
  id: string;
  family: Family;
  tier: number;
  prompt: string;
  /** Withheld under the `blind` hazard. */
  answerFormat?: string;
}

/** A task as the race sees it: the public view plus whatever verifying needs. */
export interface Task extends PublicTask {
  /**
   * Hazards in force for the yard this task belongs to. Marking depends on
   * them, so they ride along with the task rather than being looked up from
   * the hour - that keeps every family independent of the ramp.
   */
  hazards: Hazard[];
  /** Family-private payload. Never leaves the engine. */
  secret: unknown;
}

/** Strip everything an entrant must not see. */
export function publicView(task: Task): PublicTask {
  const view: PublicTask = {
    id: task.id,
    family: task.family,
    tier: task.tier,
    prompt: task.prompt,
  };
  if (task.answerFormat !== undefined) view.answerFormat = task.answerFormat;
  return view;
}

export interface VerifyResult {
  ok: boolean;
  /** Human-readable canonical answer, for the race report. */
  expected: string;
  /** What the entrant actually said, trimmed for display. */
  got: string;
  note?: string;
}

/** A challenge family: generates tasks at a tier, and grades them. */
export interface ChallengeModule {
  family: Family;
  /** One line for the dashboard and the rules page. */
  blurb: string;
  /** The lowest yard tier at which this family is fair game. */
  minTier: number;
  generate(ctx: GenerateContext): Task;
  verify(task: Task, raw: string): VerifyResult;
}

export interface GenerateContext {
  rng: import('./rng.js').Rng;
  /** 0-9. Higher is harder. */
  tier: number;
  hour: number;
  hazards: readonly Hazard[];
  id: string;
}

/** Everything the difficulty ramp decides about one hour. */
export interface YardRules {
  hour: number;
  tier: number;
  taskCount: number;
  /** How long an hour is in this race. 3_600_000 unless the race is compressed. */
  hourMs: number;
  /** Time an entrant gets, from bell to cutoff. */
  cutoffMs: number;
  /** Advisory budget included in the brief. Enforced only by adapters that can. */
  tokenBudget: number;
  families: Family[];
  hazards: Hazard[];
}

/** A generated hour, ready to send out. */
export interface Yard {
  hour: number;
  rules: YardRules;
  tasks: Task[];
  /** True when the corral is down to two: this yard can end the race. */
  decider: boolean;
}

/** What an entrant receives at the bell. */
export interface YardBrief {
  hour: number;
  tier: number;
  taskCount: number;
  /** How long an hour is in this race. Compressed races shorten it. */
  hourMs: number;
  cutoffMs: number;
  tokenBudget: number;
  hazards: Hazard[];
  /** True when the corral is down to two: this yard can end the race. */
  decider: boolean;
  tasks: PublicTask[];
}

/** What an entrant sends back before the cutoff. */
export interface Submission {
  /** taskId -> raw answer text. */
  answers: Record<string, string>;
  /**
   * Simulated entrants report their own elapsed time so a whole race can run
   * in milliseconds. Live entrants leave it out and get wall-clock timing.
   */
  elapsedMs?: number;
  tokensUsed?: number;
  note?: string;
}

export type OutReason =
  | 'missed_cutoff'
  | 'wrong_answer'
  | 'no_submission'
  | 'error'
  | 'withdrew';

export interface TaskOutcome {
  taskId: string;
  family: Family;
  ok: boolean;
  expected: string;
  got: string;
  note?: string;
}

/** One entrant's attempt at one yard. */
export interface YardResult {
  hour: number;
  entrantId: string;
  finished: boolean;
  elapsedMs: number;
  tokensUsed: number;
  outcomes: TaskOutcome[];
  outReason?: OutReason;
  errorMessage?: string;
}

export type EntrantStatus = 'in_corral' | 'running' | 'out' | 'winner' | 'no_winner';

export interface EntrantState {
  id: string;
  bib: number;
  name: string;
  team: string;
  teamSlug: string;
  kind: string;
  status: EntrantStatus;
  /** Yards completed. The only number that decides anything. */
  yards: number;
  tasksSolved: number;
  tasksAttempted: number;
  totalElapsedMs: number;
  totalTokens: number;
  outAtHour?: number;
  outReason?: OutReason;
  /** Runner-up: the last entrant eliminated. Backyard ultras call it an assist. */
  assist?: boolean;
  lastNote?: string;
}

export type RaceStatus = 'idle' | 'running' | 'finished';

export interface RaceSummary {
  seed: string;
  status: RaceStatus;
  hour: number;
  startedAt: number;
  finishedAt?: number;
  winner?: EntrantState;
  assist?: EntrantState;
  /** True when the race ended with nobody completing the deciding yard. */
  noWinner: boolean;
  entrants: EntrantState[];
  teams: TeamStanding[];
}

export interface TeamStanding {
  team: string;
  slug: string;
  bestYards: number;
  entrants: number;
  survivors: number;
  won: boolean;
}
