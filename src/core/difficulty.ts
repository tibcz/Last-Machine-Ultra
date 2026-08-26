/**
 * The ramp.
 *
 * In a real backyard ultra the loop never changes - the runner does. We have no
 * bodies to wear out, so the yard has to do the wearing. Every hour turns four
 * dials at once, and none of them ever turn back:
 *
 *   TIER      the same families, generated meaner (a new tier every 3 hours)
 *   VOLUME    more tasks in the yard (a new task every 4 hours)
 *   CUTOFF    less of the hour to do them in (-3.5% per hour, floor at 10%)
 *   BUDGET    a smaller token allowance (-7% per hour, floor at 600)
 *
 * On top of that, new families unlock as the night goes on, and hazards land at
 * fixed hours. The ramp is pure - `rulesForHour(9)` is the same forever - so a
 * team can develop against hour 30 without waiting thirty hours for it.
 */

import { FAMILIES, type Family, type Hazard, type YardRules } from './types.js';

export const MAX_TIER = 9;

export interface RampConfig {
  /** Wall-clock length of one hour. Compressed races shrink this. */
  hourMs: number;
  /** Tasks in the first yard. */
  baseTasks: number;
  /** Hard ceiling on tasks per yard, before the midnight hazard. */
  maxTasks: number;
  /** Share of the hour available in yard 1. */
  baseCutoffFraction: number;
  /** Multiplied into the cutoff fraction each hour. */
  cutoffDecay: number;
  /** The cutoff never drops below this share of the hour. */
  minCutoffFraction: number;
  baseTokens: number;
  tokenDecay: number;
  minTokens: number;
  /** Hours per tier step. */
  hoursPerTier: number;
  /** Hours per extra task. */
  hoursPerTask: number;
}

export const DEFAULT_RAMP: RampConfig = {
  hourMs: 3_600_000,
  baseTasks: 1,
  maxTasks: 5,
  baseCutoffFraction: 0.92,
  cutoffDecay: 0.965,
  minCutoffFraction: 0.1,
  baseTokens: 24_000,
  tokenDecay: 0.93,
  minTokens: 600,
  hoursPerTier: 3,
  hoursPerTask: 4,
};

/** The hour each family joins the pool. */
export const FAMILY_UNLOCK: Record<Family, number> = {
  modchain: 1,
  sequence: 1,
  cipher: 3,
  spec: 5,
  pathfind: 7,
  knights: 9,
  needle: 11,
  knapsack: 13,
  latin: 16,
  ultrasm: 19,
};

/** The hour each hazard lands. */
export const HAZARD_ONSET: Record<Hazard, number> = {
  terse: 8,
  decoys: 14,
  no_scratch: 20,
  blind: 26,
  midnight: 32,
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function tierForHour(hour: number, cfg: RampConfig = DEFAULT_RAMP): number {
  return clamp(Math.floor((hour - 1) / cfg.hoursPerTier), 0, MAX_TIER);
}

export function hazardsForHour(hour: number): Hazard[] {
  return (Object.keys(HAZARD_ONSET) as Hazard[])
    .filter((h) => hour >= HAZARD_ONSET[h])
    .sort((a, b) => HAZARD_ONSET[a] - HAZARD_ONSET[b]);
}

export function familiesForHour(hour: number): Family[] {
  return FAMILIES.filter((f) => hour >= FAMILY_UNLOCK[f]);
}

export function cutoffMsForHour(hour: number, cfg: RampConfig = DEFAULT_RAMP): number {
  const fraction = clamp(
    cfg.baseCutoffFraction * Math.pow(cfg.cutoffDecay, hour - 1),
    cfg.minCutoffFraction,
    cfg.baseCutoffFraction,
  );
  return Math.max(1, Math.round(cfg.hourMs * fraction));
}

export function tokenBudgetForHour(hour: number, cfg: RampConfig = DEFAULT_RAMP): number {
  return Math.max(cfg.minTokens, Math.round(cfg.baseTokens * Math.pow(cfg.tokenDecay, hour - 1)));
}

export function rulesForHour(hour: number, cfg: RampConfig = DEFAULT_RAMP): YardRules {
  if (!Number.isInteger(hour) || hour < 1) {
    throw new RangeError(`hour must be a positive integer, got ${hour}`);
  }

  const hazards = hazardsForHour(hour);
  const midnight = hazards.includes('midnight');

  const tier = midnight ? MAX_TIER : tierForHour(hour, cfg);
  const taskCount =
    Math.min(cfg.maxTasks, cfg.baseTasks + Math.floor((hour - 1) / cfg.hoursPerTask)) +
    (midnight ? 1 : 0);

  return {
    hour,
    tier,
    taskCount,
    hourMs: cfg.hourMs,
    cutoffMs: cutoffMsForHour(hour, cfg),
    tokenBudget: tokenBudgetForHour(hour, cfg),
    families: familiesForHour(hour),
    hazards,
  };
}

/**
 * Which families this yard actually draws from.
 *
 * Unlocking a family is not enough to make it likely - late hours have to lean
 * on the families that only exist late, or hour 40 looks like hour 4 with
 * bigger numbers. Weight is the hour a family unlocked: the newest arrivals are
 * the most likely to show up.
 */
export function familyWeights(hour: number): Array<readonly [Family, number]> {
  return familiesForHour(hour).map((f) => [f, 1 + FAMILY_UNLOCK[f] * 0.6] as const);
}

/** A one-line description of the hour, for the dashboard and the CLI. */
export function describeRules(rules: YardRules, cfg: RampConfig = DEFAULT_RAMP): string {
  const cutoffShare = Math.round((rules.cutoffMs / cfg.hourMs) * 100);
  const parts = [
    `HOUR ${String(rules.hour).padStart(2, '0')}`,
    `tier ${rules.tier}`,
    `${rules.taskCount} task${rules.taskCount === 1 ? '' : 's'}`,
    `cutoff ${formatDuration(rules.cutoffMs)} (${cutoffShare}%)`,
    `${rules.tokenBudget} tok`,
  ];
  if (rules.hazards.length > 0) parts.push(rules.hazards.join('+'));
  return parts.join('  |  ');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}
