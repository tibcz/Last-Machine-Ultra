/**
 * KNAPSACK - the highest-value load that fits.
 *
 * Straight 0/1 knapsack at low tier. From tier 5 a cap on the number of items
 * lands on top of it, which breaks the greedy value-per-weight instinct that
 * gets the easy version right often enough to be dangerous.
 */

import type { ChallengeModule, GenerateContext, Task } from './deps.js';
import { byTier, buildTask, mark, withDecoys } from './util.js';

interface Item {
  name: string;
  weight: number;
  value: number;
}

interface Secret {
  items: Item[];
  capacity: number;
  maxItems?: number;
  answer: number;
}

/** DP over (weight, items used). `maxItems` of Infinity collapses to plain 0/1. */
function solve(items: Item[], capacity: number, maxItems: number): number {
  const cap = Math.min(maxItems, items.length);
  // table[k][w] = best value using exactly at most k items within weight w
  let previous: number[][] = Array.from({ length: cap + 1 }, () => new Array<number>(capacity + 1).fill(0));

  for (const item of items) {
    const next: number[][] = previous.map((row) => row.slice());
    for (let k = 1; k <= cap; k++) {
      for (let w = item.weight; w <= capacity; w++) {
        const candidate = previous[k - 1]![w - item.weight]! + item.value;
        if (candidate > next[k]![w]!) next[k]![w] = candidate;
      }
    }
    previous = next;
  }

  let best = 0;
  for (let k = 0; k <= cap; k++) {
    for (let w = 0; w <= capacity; w++) {
      if (previous[k]![w]! > best) best = previous[k]![w]!;
    }
  }
  return best;
}

export const knapsack: ChallengeModule = {
  family: 'knapsack',
  blurb: 'Maximise loaded value under a weight limit, and later an item limit too.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards } = ctx;

    const count = byTier(tier, 6, 18);
    const items: Item[] = [];
    const used = new Set<string>();
    while (items.length < count) {
      const name = rng.word(3, 6).toUpperCase();
      if (used.has(name)) continue;
      used.add(name);
      items.push({ name, weight: rng.int(3, 40), value: rng.int(5, 120) });
    }

    const totalWeight = items.reduce((sum, i) => sum + i.weight, 0);
    // A capacity around 40% of the total is where the problem is hardest:
    // too small and nothing fits, too large and everything does.
    const capacity = Math.max(10, Math.round(totalWeight * rng.float(0.3, 0.5)));
    const maxItems = tier >= 5 ? rng.int(3, Math.max(4, Math.floor(count / 2))) : undefined;

    const answer = solve(items, capacity, maxItems ?? items.length);

    const table = [
      'item     weight  value',
      ...items.map(
        (i) => `${i.name.padEnd(9)}${String(i.weight).padStart(6)}${String(i.value).padStart(7)}`,
      ),
    ].join('\n');

    const constraints = [`Total weight must not exceed ${capacity}.`];
    if (maxItems !== undefined) constraints.push(`At most ${maxItems} items may be taken.`);

    const head = hazards.includes('terse')
      ? `0/1. cap=${capacity}${maxItems !== undefined ? ` n<=${maxItems}` : ''}. maximise value.`
      : 'Each item may be taken at most once. Choose a subset that maximises total value.';

    const prompt = withDecoys(
      [head, '', table, '', ...constraints, '', 'What is the maximum total value?'].join('\n'),
      rng,
      tier,
      hazards,
    );

    const secret: Secret = { items, capacity, answer };
    if (maxItems !== undefined) secret.maxItems = maxItems;

    return buildTask(ctx, 'knapsack', prompt, 'A single integer: the maximum total value.', secret);
  },

  verify(task: Task, raw: string) {
    const secret = task.secret as Secret;
    return mark(task, raw, String(secret.answer), 'int', task.hazards);
  },
};

export const knapsackInternals = { solve };
