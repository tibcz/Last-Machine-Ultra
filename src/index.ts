/**
 * Last Machine Ultra, as a library.
 *
 * The CLI is the intended way in, but everything it uses is exported here so a
 * race can be embedded, a ramp inspected, or a single yard generated and marked
 * without going near the command line.
 */

export {
  REGISTRY,
  briefFor,
  generateYard,
  moduleFor,
  solutionFor,
  verifyTask,
} from './challenges/index.js';

export { DEFAULT_LIMITS, execute, parse, run as runProgram } from './challenges/vm.js';
export type { Opcode, Program, VmLimits } from './challenges/vm.js';

export { CompressedClock, InstantClock, WallClock } from './core/clock.js';
export type { RaceClock } from './core/clock.js';

export {
  DEFAULT_RAMP,
  FAMILY_UNLOCK,
  HAZARD_ONSET,
  MAX_TIER,
  cutoffMsForHour,
  describeRules,
  familiesForHour,
  formatDuration,
  hazardsForHour,
  rulesForHour,
  tierForHour,
  tokenBudgetForHour,
} from './core/difficulty.js';
export type { RampConfig } from './core/difficulty.js';

export { Race, standings } from './core/race.js';
export type { RaceEvents, RaceOptions, YardReport } from './core/race.js';

export { Rng, hashSeed, randomSeed, taskRng } from './core/rng.js';

export {
  FAMILIES,
  HAZARDS,
  HAZARD_BLURB,
  publicView,
} from './core/types.js';
export type {
  ChallengeModule,
  EntrantState,
  Family,
  Hazard,
  OutReason,
  PublicTask,
  RaceSummary,
  Submission,
  Task,
  TaskOutcome,
  TeamStanding,
  VerifyResult,
  Yard,
  YardBrief,
  YardResult,
  YardRules,
} from './core/types.js';

export { BOTS, LocalBot, makeLocalBot } from './competitors/local.js';
export type { BotProfile } from './competitors/local.js';
export { SYSTEM_PROMPT, parseAnswers, renderBrief, renderTask } from './competitors/prompting.js';
export { AnthropicCompetitor, HttpCompetitor, OpenAICompetitor } from './competitors/remote.js';
export { isSimulated } from './competitors/types.js';
export type { Competitor, RunContext, SimulatedCompetitor } from './competitors/types.js';

export { ADAPTERS, buildCompetitors, loadRoster, validateTeam } from './registry/roster.js';
export type { Adapter, LoadedRoster, RosterEntrant, RosterProblem, TeamFile } from './registry/roster.js';

export { serveRace } from './server/server.js';
