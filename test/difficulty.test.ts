import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_RAMP,
  FAMILY_UNLOCK,
  HAZARD_ONSET,
  MAX_TIER,
  cutoffMsForHour,
  familiesForHour,
  hazardsForHour,
  rulesForHour,
  tierForHour,
  tokenBudgetForHour,
} from '../src/core/difficulty.js';
import { Rng, hashSeed, taskRng } from '../src/core/rng.js';
import { FAMILIES, HAZARDS } from '../src/core/types.js';

const HOURS = Array.from({ length: 72 }, (_, i) => i + 1);

describe('the ramp only ever gets harder', () => {
  it('tier never goes down', () => {
    for (const hour of HOURS.slice(1)) {
      assert.ok(
        tierForHour(hour) >= tierForHour(hour - 1),
        `tier fell between hour ${hour - 1} and ${hour}`,
      );
    }
  });

  it('the cutoff never grows and the token budget never grows', () => {
    for (const hour of HOURS.slice(1)) {
      assert.ok(cutoffMsForHour(hour) <= cutoffMsForHour(hour - 1), `cutoff grew at hour ${hour}`);
      assert.ok(
        tokenBudgetForHour(hour) <= tokenBudgetForHour(hour - 1),
        `token budget grew at hour ${hour}`,
      );
    }
  });

  it('task count never goes down, except where midnight adds one', () => {
    let previous = 0;
    for (const hour of HOURS) {
      const count = rulesForHour(hour).taskCount;
      assert.ok(count >= previous, `task count fell at hour ${hour}`);
      previous = count;
    }
  });

  it('a family, once unlocked, stays unlocked', () => {
    let previous: string[] = [];
    for (const hour of HOURS) {
      const families = familiesForHour(hour);
      for (const family of previous) {
        assert.ok(families.includes(family as never), `${family} vanished at hour ${hour}`);
      }
      previous = families;
    }
  });

  it('every family and hazard eventually arrives', () => {
    const lastHour = Math.max(...Object.values(FAMILY_UNLOCK), ...Object.values(HAZARD_ONSET));
    const rules = rulesForHour(lastHour);
    assert.deepEqual([...rules.families].sort(), [...FAMILIES].sort());
    assert.deepEqual([...rules.hazards].sort(), [...HAZARDS].sort());
  });

  it('respects its own bounds', () => {
    for (const hour of HOURS) {
      const rules = rulesForHour(hour);
      assert.ok(rules.tier >= 0 && rules.tier <= MAX_TIER, `tier out of range at hour ${hour}`);
      assert.ok(rules.cutoffMs > 0, `non-positive cutoff at hour ${hour}`);
      assert.ok(
        rules.cutoffMs >= DEFAULT_RAMP.hourMs * DEFAULT_RAMP.minCutoffFraction - 1,
        `cutoff dipped below the floor at hour ${hour}`,
      );
      assert.ok(rules.tokenBudget >= DEFAULT_RAMP.minTokens, `token floor broken at hour ${hour}`);
      assert.ok(rules.taskCount >= 1);
    }
  });

  it('is a pure function of the hour', () => {
    assert.deepEqual(rulesForHour(29), rulesForHour(29));
    assert.notDeepEqual(rulesForHour(29), rulesForHour(30));
  });

  it('rejects an hour that is not a positive integer', () => {
    assert.throws(() => rulesForHour(0), RangeError);
    assert.throws(() => rulesForHour(-3), RangeError);
    assert.throws(() => rulesForHour(2.5), RangeError);
  });
});

describe('hazards land on schedule', () => {
  it('each one arrives at its stated hour and never leaves', () => {
    for (const [hazard, onset] of Object.entries(HAZARD_ONSET)) {
      assert.equal(hazardsForHour(onset - 1).includes(hazard as never), false, `${hazard} arrived early`);
      assert.equal(hazardsForHour(onset).includes(hazard as never), true, `${hazard} was late`);
      assert.equal(hazardsForHour(onset + 20).includes(hazard as never), true, `${hazard} wore off`);
    }
  });

  it('midnight pins the tier to maximum and lengthens the yard', () => {
    const before = rulesForHour(HAZARD_ONSET.midnight - 1);
    const after = rulesForHour(HAZARD_ONSET.midnight);
    assert.equal(after.tier, MAX_TIER);
    assert.equal(after.taskCount, before.taskCount + 1);
  });
});

describe('seeded randomness', () => {
  it('the same seed gives the same stream', () => {
    const a = new Rng('SEED');
    const b = new Rng('SEED');
    for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
  });

  it('different seeds diverge', () => {
    assert.notEqual(new Rng('A').next(), new Rng('B').next());
    assert.notEqual(hashSeed('a', 1), hashSeed('a', 2));
  });

  it('stays inside its stated ranges', () => {
    const rng = new Rng('RANGES');
    for (let i = 0; i < 2000; i++) {
      const value = rng.int(3, 9);
      assert.ok(Number.isInteger(value) && value >= 3 && value <= 9);
      const f = rng.float(-1, 1);
      assert.ok(f >= -1 && f < 1);
    }
  });

  it('int is inclusive at both ends', () => {
    const rng = new Rng('ENDS');
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(rng.int(0, 2));
    assert.deepEqual([...seen].sort(), [0, 1, 2]);
  });

  it('shuffle and sample keep every element and do not mutate the input', () => {
    const rng = new Rng('SHUFFLE');
    const source = [1, 2, 3, 4, 5];
    const shuffled = rng.shuffle(source);
    assert.deepEqual(source, [1, 2, 3, 4, 5]);
    assert.deepEqual([...shuffled].sort(), source);
    assert.equal(rng.sample(source, 3).length, 3);
    assert.equal(new Set(rng.sample(source, 4)).size, 4);
    assert.equal(rng.sample(source, 99).length, 5);
  });

  it('weighted respects a zero weight', () => {
    const rng = new Rng('WEIGHTS');
    for (let i = 0; i < 200; i++) {
      assert.equal(
        rng.weighted([
          ['never', 0],
          ['always', 1],
        ]),
        'always',
      );
    }
  });

  it('task streams are independent per hour and index', () => {
    assert.notEqual(taskRng('S', 1, 0).next(), taskRng('S', 2, 0).next());
    assert.notEqual(taskRng('S', 1, 0).next(), taskRng('S', 1, 1).next());
    assert.equal(taskRng('S', 1, 0).next(), taskRng('S', 1, 0).next());
  });

  it('pick throws on an empty list rather than returning undefined', () => {
    assert.throws(() => new Rng('X').pick([]));
  });
});
