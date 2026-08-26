/**
 * Simulated entrants.
 *
 * These exist so a full race runs in a second, with no API keys and no network
 * - for tests, for demos, and for filling a corral so a single real team has
 * something to race against.
 *
 * They do not solve anything. Each bot has a personality expressed as four
 * numbers, and for every task it rolls against them to decide whether to submit
 * the canonical answer or a plausible corruption of it. Time is modelled the
 * same way: a bot's work is priced in fractions of an hour, independent of the
 * cutoff, so the shrinking cutoff genuinely catches slow bots as the night
 * wears on. That is why a `grinder` dies to the clock while a `sprinter` dies
 * to its own fading accuracy.
 */

import { Rng, hashSeed } from '../core/rng.js';
import type { Hazard, Submission, YardBrief } from '../core/types.js';
import type { RunContext, SimulatedCompetitor } from './types.js';

export interface BotProfile {
  /**
   * The difficulty, in tier units, at which this bot gets a task right half the
   * time. Tier 0 tasks should be near-certain for anything worth entering, so
   * these numbers sit well above the tier range - the ramp is what closes the
   * gap.
   */
  capability: number;
  /** How sharply ability falls away past `capability`. Small means a cliff. */
  softness: number;
  /** Resistance to hour-on-hour fatigue. 1 means none at all. */
  stamina: number;
  /** How quickly it works. Drives elapsed time, and so the cutoff. */
  speed: number;
  /** Hour-to-hour swing in form, in tier units. */
  variance: number;
  blurb: string;
}

export const BOTS: Record<string, BotProfile> = {
  pacer: {
    capability: 11.6,
    softness: 1.1,
    stamina: 0.8,
    speed: 0.55,
    variance: 0.5,
    blurb: 'Metronomic. Rarely brilliant, rarely stupid.',
  },
  sprinter: {
    capability: 12.4,
    softness: 0.7,
    stamina: 0.34,
    speed: 0.92,
    variance: 0.6,
    blurb: 'Untouchable for a dozen hours, then falls off a cliff.',
  },
  grinder: {
    capability: 11.0,
    softness: 1.5,
    stamina: 0.94,
    speed: 0.33,
    variance: 0.4,
    blurb: 'Never rattled, never quick. Dies to the cutoff, not the maths.',
  },
  spark: {
    capability: 11.9,
    softness: 1.0,
    stamina: 0.62,
    speed: 0.72,
    variance: 1.9,
    blurb: 'Wildly inconsistent. Survives yards nobody else does, loses yards nobody else loses.',
  },
  bricklayer: {
    capability: 11.2,
    softness: 1.3,
    stamina: 0.99,
    speed: 0.5,
    variance: 0.25,
    blurb: 'Does not get tired. Does not get faster either.',
  },
  oracle: {
    capability: 999,
    softness: 1,
    stamina: 1,
    speed: 0.95,
    variance: 0,
    blurb: 'Never wrong. In the roster so the tests have a control, and to prove the clock beats everyone eventually.',
  },
};

/** What each hazard adds to a task's effective difficulty, in tier units. */
const HAZARD_COST: Record<Hazard, number> = {
  terse: 0.25,
  decoys: 0.4,
  no_scratch: 0.5,
  blind: 0.5,
  midnight: 0.8,
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * A wrong answer that looks like it came from an honest mistake, not from
 * giving up. A bot that submitted "xxx" would make the race reports useless.
 */
export function corrupt(solution: string, rng: Rng): string {
  const trimmed = solution.trim();
  if (trimmed.length === 0) return '0';

  // A program: break it the way a real attempt breaks - drop a line, or nudge
  // a constant.
  if (/\n/.test(trimmed) && /^[A-Z]+/m.test(trimmed)) {
    const lines = trimmed.split('\n');
    if (rng.bool(0.5) && lines.length > 3) {
      lines.splice(rng.int(1, lines.length - 2), 1);
      return lines.join('\n');
    }
    return lines
      .map((line) => line.replace(/\b(\d+)\b/, (m) => (rng.bool(0.25) ? String(Number(m) + 1) : m)))
      .join('\n');
  }

  // A list: swap a pair, or change one member.
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map((p) => p.trim());
    if (parts.length > 1 && rng.bool(0.5)) {
      const i = rng.int(0, parts.length - 1);
      const j = (i + 1) % parts.length;
      [parts[i], parts[j]] = [parts[j]!, parts[i]!];
      return parts.join(', ');
    }
    const i = rng.int(0, parts.length - 1);
    parts[i] = corrupt(parts[i]!, rng);
    return parts.join(', ');
  }

  // A number: off by a little, or a transposed digit.
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return String(rng.bool(0.6) ? n + rng.pick([-2, -1, 1, 2, 10, -10]) : Number(String(n).split('').reverse().join('')) || n + 1);
  }

  // Text: change one character.
  const at = rng.int(0, trimmed.length - 1);
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const replacement = rng.pick(letters.split(''));
  return trimmed.slice(0, at) + replacement + trimmed.slice(at + 1);
}

export class LocalBot implements SimulatedCompetitor {
  readonly simulated = true;
  readonly kind: string;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly team: string,
    readonly teamSlug: string,
    readonly bot: string,
    private readonly profile: BotProfile,
    private readonly seed: string,
  ) {
    this.kind = `local:${bot}`;
    // Two entrants of the same type are not the same runner. Fixed jitter,
    // drawn once per race, gives a field of five archetypes the continuum a
    // real start line has.
    //
    // Jittering speed matters as much as jittering skill, and for a subtler
    // reason: the cutoff is a threshold everyone shares, so entrants who work
    // at the same rate die to it in a batch. If that batch is the last two,
    // the race ends with no winner. Spreading the pace out makes the clock
    // eliminate one at a time, the way it does in a real ultra.
    const jitter = new Rng(hashSeed(seed, id, 'jitter'));
    this.capability = profile.capability + (jitter.next() - 0.5) * 5;
    this.speed = clamp(profile.speed + (jitter.next() - 0.5) * 0.3, 0.05, 1);
  }

  /** This entrant's capability for this race: the profile's, plus jitter. */
  readonly capability: number;
  /** This entrant's speed for this race: the profile's, plus jitter. */
  readonly speed: number;

  async runSimulated(
    brief: YardBrief,
    solutions: Readonly<Record<string, string>>,
    _ctx: RunContext,
  ): Promise<Submission> {
    const rng = new Rng(hashSeed(this.seed, this.id, 'hour', brief.hour));
    const { softness, stamina, variance } = this.profile;
    const { capability, speed } = this;

    // Form for the hour: one roll, applied to every task in the yard. A bad
    // hour should look like a bad hour, not like independent coin flips.
    const form = variance * (rng.next() * 2 - 1);
    const fatigue = (1 - stamina) * brief.hour * 0.22;
    const hazardCost = brief.hazards.reduce((sum, h) => sum + (HAZARD_COST[h] ?? 0), 0);

    const answers: Record<string, string> = {};
    for (const task of brief.tasks) {
      // Everything that makes a task hard is expressed in the same unit - tier -
      // and compared against the bot's capability on a logistic curve.
      const load = task.tier + hazardCost + fatigue - form;
      const chance = clamp(1 / (1 + Math.exp((load - capability) / softness)), 0.005, 0.999);
      const solution = solutions[task.id] ?? '';
      answers[task.id] = rng.bool(chance) ? solution : corrupt(solution, rng);
    }

    // Work is priced in fractions of an hour and compared against a cutoff that
    // shrinks every hour. This is where slow bots eventually lose - and where
    // even a flawless one does, which is the point of the format.
    const perTask = 0.052 + 0.074 * (brief.tier / 9);
    // Wide enough that the cutoff picks entrants off one at a time, narrow
    // enough that being fastest is an advantage rather than the whole race.
    const pace = 1.15 + 0.9 * speed;
    const work =
      ((brief.taskCount * perTask) / pace) *
      (1 + (1 - stamina) * brief.hour * 0.012) *
      (1 + 0.5 * (rng.next() - 0.5));

    return {
      answers,
      elapsedMs: Math.round(work * brief.hourMs),
      tokensUsed: Math.round(
        brief.tokenBudget * clamp(0.45 + 0.4 * (1 - speed) + 0.05 * form, 0.1, 1.6),
      ),
      note: this.kind,
    };
  }

  async run(brief: YardBrief, ctx: RunContext): Promise<Submission> {
    // A simulated bot with no answers to work from can only fail honestly.
    return this.runSimulated(brief, {}, ctx);
  }
}

export function makeLocalBot(options: {
  id: string;
  name: string;
  team: string;
  teamSlug: string;
  bot: string;
  seed: string;
}): LocalBot {
  const profile = BOTS[options.bot];
  if (!profile) {
    throw new Error(`unknown bot "${options.bot}". Known bots: ${Object.keys(BOTS).join(', ')}`);
  }
  return new LocalBot(
    options.id,
    options.name,
    options.team,
    options.teamSlug,
    options.bot,
    profile,
    options.seed,
  );
}
