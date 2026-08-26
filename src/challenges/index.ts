/**
 * The challenge registry: turns an hour's rules into an actual yard.
 */

import { familyWeights } from '../core/difficulty.js';
import { taskRng } from '../core/rng.js';
import {
  publicView,
  type ChallengeModule,
  type Family,
  type Task,
  type VerifyResult,
  type Yard,
  type YardBrief,
  type YardRules,
} from '../core/types.js';

import { cipher } from './cipher.js';
import { knapsack } from './knapsack.js';
import { knights } from './knights.js';
import { latin } from './latin.js';
import { modchain } from './modchain.js';
import { needle } from './needle.js';
import { pathfind } from './pathfind.js';
import { sequence } from './sequence.js';
import { spec } from './spec.js';
import { ultrasm } from './ultrasm.js';

export const REGISTRY: Record<Family, ChallengeModule> = {
  modchain,
  sequence,
  cipher,
  spec,
  pathfind,
  knights,
  needle,
  knapsack,
  latin,
  ultrasm,
};

export function moduleFor(family: Family): ChallengeModule {
  const module = REGISTRY[family];
  if (!module) throw new Error(`no challenge module registered for "${family}"`);
  return module;
}

/**
 * Build one hour's yard.
 *
 * Family choice is seeded, so two runs of the same race produce identical
 * yards. Repeats are avoided while there are unused families left - a yard of
 * four MODCHAINs would be a worse test than a yard of four different things.
 */
export function generateYard(seed: string, rules: YardRules, decider = false): Yard {
  const chooser = taskRng(seed, rules.hour, -1, 'families');
  const weights = familyWeights(rules.hour);
  const used = new Set<Family>();
  const tasks: Task[] = [];

  for (let index = 0; index < rules.taskCount; index++) {
    const remaining = weights.filter(([family]) => !used.has(family));
    const family = chooser.weighted(remaining.length > 0 ? remaining : weights);
    used.add(family);

    tasks.push(
      moduleFor(family).generate({
        rng: taskRng(seed, rules.hour, index, family),
        tier: rules.tier,
        hour: rules.hour,
        hazards: rules.hazards,
        id: `H${rules.hour}T${index + 1}`,
      }),
    );
  }

  return { hour: rules.hour, rules, tasks, decider };
}

/** The entrant-facing view of a yard. Everything secret is stripped here. */
export function briefFor(yard: Yard): YardBrief {
  return {
    hour: yard.hour,
    tier: yard.rules.tier,
    taskCount: yard.tasks.length,
    hourMs: yard.rules.hourMs,
    cutoffMs: yard.rules.cutoffMs,
    tokenBudget: yard.rules.tokenBudget,
    hazards: [...yard.rules.hazards],
    decider: yard.decider,
    tasks: yard.tasks.map(publicView),
  };
}

export function verifyTask(task: Task, raw: string): VerifyResult {
  try {
    return moduleFor(task.family).verify(task, raw ?? '');
  } catch (error) {
    return {
      ok: false,
      expected: '(verifier error)',
      got: (raw ?? '').slice(0, 120),
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The canonical answer for a task - what a flawless entrant would submit.
 *
 * Simulated entrants use this to "solve" a task, and `lmu yard --solutions`
 * prints it. It reads whatever shape each family stores its answer in, so a
 * family that invents a new one has to be added here too - the test suite
 * checks that every family's solution actually marks as correct.
 */
export function solutionFor(task: Task): string {
  const secret = task.secret as Record<string, unknown>;
  if (typeof secret?.['reference'] === 'string') return secret['reference'] as string;
  if (typeof secret?.['answer'] === 'string') return secret['answer'] as string;
  if (typeof secret?.['answer'] === 'number') return String(secret['answer']);
  if (Array.isArray(secret?.['answer'])) return (secret['answer'] as unknown[]).join(', ');
  if (typeof secret?.['plaintext'] === 'string') return secret['plaintext'] as string;
  if (Array.isArray(secret?.['knights'])) {
    const list = secret['knights'] as string[];
    return list.length > 0 ? list.join(', ') : 'NONE';
  }
  return '';
}

export { cipher, knapsack, knights, latin, modchain, needle, pathfind, sequence, spec, ultrasm };
