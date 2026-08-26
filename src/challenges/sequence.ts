/**
 * SEQUENCE - continue a generated recurrence.
 *
 * The trap is that the rule is never stated. Low tiers are ordinary linear
 * recurrences; from tier 3 an index term is folded in, and from tier 6 the sign
 * alternates, so the obvious two-term fit stops working. Under `decoys` the
 * series is prefixed with terms from a different, plausible recurrence and
 * marked as belonging to an earlier run.
 */

import type { ChallengeModule, GenerateContext, Task } from './deps.js';
import { byTier, buildTask, mark } from './util.js';

interface Secret {
  coefficients: number[];
  offset: number;
  indexWeight: number;
  alternating: boolean;
  shown: number[];
  answer: number[];
}

export const sequence: ChallengeModule = {
  family: 'sequence',
  blurb: 'Infer the rule behind a generated recurrence and extend it.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards } = ctx;

    const order = byTier(tier, 2, 4);
    const coefficients = Array.from({ length: order }, () => rng.int(-4, 6) || 2);
    const offset = tier >= 1 ? rng.int(-9, 9) : 0;
    const indexWeight = tier >= 3 ? rng.int(1, 3) : 0;
    const alternating = tier >= 6 && rng.bool(0.6);

    const seeds = Array.from({ length: order }, () => rng.int(1, 12));
    const showCount = byTier(tier, 7, 10);
    const askCount = byTier(tier, 1, 3);

    const terms = [...seeds];
    for (let i = order; i < showCount + askCount; i++) {
      let next = offset + indexWeight * i;
      for (let c = 0; c < order; c++) {
        next += coefficients[c]! * terms[i - 1 - c]!;
      }
      if (alternating && i % 2 === 1) next = -next;
      terms.push(next);
    }

    const shown = terms.slice(0, showCount);
    const answer = terms.slice(showCount, showCount + askCount);

    let series = shown.join(', ');
    if (hazards.includes('decoys')) {
      // A decoy prefix from a different rule. It is clearly labelled as a
      // previous run - and it fits a two-term recurrence beautifully, which is
      // exactly the wrong thing to notice.
      const fake = [rng.int(1, 9), rng.int(1, 9)];
      for (let i = 2; i < 6; i++) fake.push(fake[i - 1]! + fake[i - 2]!);
      series = `[previous run, unrelated: ${fake.join(', ')}]\n${series}`;
    }

    const ordinals = Array.from(
      { length: askCount },
      (_, i) => `#${showCount + i + 1}`,
    ).join(', ');

    const prompt = [
      `Terms #1 to #${showCount} of a sequence:`,
      '',
      series,
      '',
      `Give term${askCount === 1 ? '' : 's'} ${ordinals}.`,
    ].join('\n');

    const secret: Secret = {
      coefficients,
      offset,
      indexWeight,
      alternating,
      shown,
      answer,
    };

    return buildTask(
      ctx,
      'sequence',
      prompt,
      askCount === 1 ? 'A single integer.' : `${askCount} integers, comma-separated, in order.`,
      secret,
    );
  },

  verify(task: Task, raw: string) {
    const secret = task.secret as Secret;
    const expected = secret.answer.join(', ');
    return mark(task, raw, expected, secret.answer.length === 1 ? 'int' : 'list', task.hazards);
  },
};
