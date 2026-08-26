import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REGISTRY, briefFor, generateYard, solutionFor, verifyTask } from '../src/challenges/index.js';
import { execute } from '../src/challenges/vm.js';
import { knightsInternals } from '../src/challenges/knights.js';
import { ultrasmInternals } from '../src/challenges/ultrasm.js';
import { MAX_TIER, rulesForHour } from '../src/core/difficulty.js';
import { taskRng } from '../src/core/rng.js';
import { FAMILIES, HAZARDS, publicView, type Hazard } from '../src/core/types.js';

const TIERS = Array.from({ length: MAX_TIER + 1 }, (_, i) => i);
const SEEDS = ['ALPHA', 'BRAVO', 'CHARLIE'];

/**
 * The load-bearing invariant of the whole project: whatever a family calls the
 * canonical answer, its own marker must accept it. A family that generates a
 * task it cannot pass would eliminate every entrant in the race, and it would
 * look exactly like the entrants being bad at it.
 */
describe('every family accepts its own solution', () => {
  for (const family of FAMILIES) {
    const module = REGISTRY[family];

    it(`${family} - clean, tiers 0-${MAX_TIER}`, () => {
      for (const tier of TIERS) {
        for (const seed of SEEDS) {
          const task = module.generate({
            rng: taskRng(seed, tier, 0, family),
            tier,
            hour: tier * 3 + 1,
            hazards: [],
            id: `T${tier}`,
          });
          const solution = solutionFor(task);
          assert.notEqual(solution, '', `${family} tier ${tier} produced no canonical answer`);

          const verdict = module.verify(task, solution);
          assert.ok(
            verdict.ok,
            `${family} tier ${tier} seed ${seed} rejected its own answer\n` +
              `  wanted: ${verdict.expected}\n  got:    ${verdict.got}\n  note:   ${verdict.note ?? '-'}`,
          );
        }
      }
    });

    it(`${family} - under every hazard`, () => {
      const hazards = [...HAZARDS] as Hazard[];
      for (const tier of [0, 4, MAX_TIER]) {
        const task = module.generate({
          rng: taskRng('HAZARD', tier, 0, family),
          tier,
          hour: 40,
          hazards,
          id: `H${tier}`,
        });
        const verdict = module.verify(task, solutionFor(task));
        assert.ok(
          verdict.ok,
          `${family} tier ${tier} rejected its own answer under hazards: ${verdict.note ?? ''}`,
        );
      }
    });

    it(`${family} - rejects a wrong answer`, () => {
      const task = module.generate({
        rng: taskRng('WRONG', 3, 0, family),
        tier: 3,
        hour: 10,
        hazards: [],
        id: 'W1',
      });
      assert.equal(module.verify(task, 'definitely not the answer').ok, false);
      assert.equal(module.verify(task, '').ok, false);
    });
  }
});

describe('the blind hazard withholds the answer format', () => {
  it('every family drops answerFormat under blind', () => {
    for (const family of FAMILIES) {
      const task = REGISTRY[family].generate({
        rng: taskRng('BLIND', 5, 0, family),
        tier: 5,
        hour: 26,
        hazards: ['blind'],
        id: 'B1',
      });
      assert.equal(task.answerFormat, undefined, `${family} leaked its answer format under blind`);
    }
  });
});

describe('the no_scratch hazard is enforced', () => {
  it('rejects a labelled or multi-line answer', () => {
    const task = REGISTRY['modchain'].generate({
      rng: taskRng('SCRATCH', 2, 0, 'modchain'),
      tier: 2,
      hour: 20,
      hazards: ['no_scratch'],
      id: 'S1',
    });
    const solution = solutionFor(task);

    assert.ok(REGISTRY['modchain'].verify(task, solution).ok, 'bare answer should pass');

    const labelled = REGISTRY['modchain'].verify(task, `Answer: ${solution}`);
    assert.equal(labelled.ok, false);
    assert.match(labelled.note ?? '', /no_scratch/);

    const chatty = REGISTRY['modchain'].verify(task, `Let me work through this.\n${solution}`);
    assert.equal(chatty.ok, false);
    assert.match(chatty.note ?? '', /no_scratch/);
  });

  it('accepts the same answers when the hazard is absent', () => {
    const task = REGISTRY['modchain'].generate({
      rng: taskRng('SCRATCH', 2, 0, 'modchain'),
      tier: 2,
      hour: 5,
      hazards: [],
      id: 'S1',
    });
    const solution = solutionFor(task);
    assert.ok(REGISTRY['modchain'].verify(task, `Answer: ${solution}`).ok);
    assert.ok(REGISTRY['modchain'].verify(task, `working...\nso the result is\n${solution}`).ok);
  });
});

describe('yards are deterministic and leak nothing', () => {
  it('the same seed and hour produce identical yards', () => {
    const rules = rulesForHour(17);
    const a = generateYard('REPEAT', rules);
    const b = generateYard('REPEAT', rules);
    assert.deepEqual(
      a.tasks.map((t) => t.prompt),
      b.tasks.map((t) => t.prompt),
    );
    assert.deepEqual(
      a.tasks.map((t) => solutionFor(t)),
      b.tasks.map((t) => solutionFor(t)),
    );
  });

  it('different seeds produce different yards', () => {
    const rules = rulesForHour(17);
    assert.notDeepEqual(
      generateYard('SEED-A', rules).tasks.map((t) => t.prompt),
      generateYard('SEED-B', rules).tasks.map((t) => t.prompt),
    );
  });

  it('the brief carries no secret and no hazard list on the task', () => {
    for (let hour = 1; hour <= 36; hour++) {
      const yard = generateYard('LEAK', rulesForHour(hour));
      for (const task of yard.tasks) {
        const view = publicView(task) as unknown as Record<string, unknown>;
        assert.equal('secret' in view, false, `hour ${hour}: publicView leaked "secret"`);
        assert.equal('hazards' in view, false, `hour ${hour}: publicView leaked "hazards"`);
      }
      const serialized = JSON.stringify(briefFor(yard));
      assert.equal(serialized.includes('"secret"'), false, `hour ${hour}: brief serialized a secret`);
    }
  });

  it('a yard never repeats a family while unused ones remain', () => {
    for (let hour = 1; hour <= 40; hour++) {
      const yard = generateYard('VARIETY', rulesForHour(hour));
      const families = yard.tasks.map((t) => t.family);
      const available = yard.rules.families.length;
      if (families.length <= available) {
        assert.equal(
          new Set(families).size,
          families.length,
          `hour ${hour} repeated a family with ${available} available`,
        );
      }
    }
  });
});

describe('KNIGHTS puzzles are solvable and unambiguous', () => {
  it('every generated puzzle has exactly one consistent assignment', () => {
    const { consistentWorlds } = knightsInternals;
    for (const tier of TIERS) {
      for (let seed = 0; seed < 40; seed++) {
        const task = REGISTRY['knights'].generate({
          rng: taskRng(`K${seed}`, tier, 0, 'knights'),
          tier,
          hour: 20,
          hazards: [],
          id: 'K1',
        });
        const secret = task.secret as { names: string[]; claims: never[]; knights: string[] };
        const worlds = consistentWorlds(secret.claims, secret.names.length);

        assert.equal(
          worlds.length,
          1,
          `tier ${tier} seed ${seed}: ${worlds.length} consistent worlds\n${task.prompt}`,
        );

        // And the answer we mark against is that one world.
        const expected = secret.names.filter((_, i) => worlds[0]![i]).sort();
        assert.deepEqual(secret.knights, expected);
      }
    }
  });

  it('nobody is ever made to say "I am a knave"', () => {
    for (const tier of TIERS) {
      for (let seed = 0; seed < 40; seed++) {
        const task = REGISTRY['knights'].generate({
          rng: taskRng(`P${seed}`, tier, 0, 'knights'),
          tier,
          hour: 20,
          hazards: [],
          id: 'K1',
        });
        const secret = task.secret as {
          names: string[];
          claims: Array<{ kind: string; who?: number }>;
        };
        secret.claims.forEach((claim, speaker) => {
          if (claim.kind === 'is_knight' || claim.kind === 'is_knave') {
            assert.notEqual(
              claim.who,
              speaker,
              `tier ${tier} seed ${seed}: ${secret.names[speaker]} spoke about themselves`,
            );
          }
        });
      }
    }
  });
});

describe('ULTRASM reference programs', () => {
  it('every target has a program that passes inside its step budget', () => {
    const { TARGETS, REFERENCE } = ultrasmInternals;
    for (const target of TARGETS) {
      const source = REFERENCE[target.id];
      assert.ok(source, `${target.id} has no reference program`);

      const limits = { maxSteps: target.steps(9), maxInstructions: 256, maxStack: 256, memorySlots: 32, maxMagnitude: Number.MAX_SAFE_INTEGER };
      const rng = taskRng('VECTORS', 9, 0, target.id);

      for (let i = 0; i < 24; i++) {
        const input = target.sample(rng, 9);
        const expected = target.fn(input);
        const result = execute(source!, input, limits);
        assert.ok(result.ok, `${target.id} on [${input}] failed: ${result.ok ? '' : result.error}`);
        assert.deepEqual(
          result.ok ? result.output : [],
          [expected],
          `${target.id} on [${input}] gave the wrong output`,
        );
      }
    }
  });

  it('a naive powmod blows the step budget, a fast one does not', () => {
    // The point of the tier-8 budget: correct is not enough, it has to be
    // efficient. Repeated multiplication is correct and still fails.
    const naive = [
      'IN', 'STORE 0', 'IN', 'STORE 1', 'IN', 'STORE 2',
      'PUSH 1', 'STORE 3',
      'loop:', 'LOAD 1', 'JZ done',
      'LOAD 3', 'LOAD 0', 'MUL', 'LOAD 2', 'MOD', 'STORE 3',
      'LOAD 1', 'PUSH 1', 'SUB', 'STORE 1', 'JMP loop',
      'done:', 'LOAD 3', 'OUT', 'HALT',
    ].join('\n');

    const target = ultrasmInternals.TARGETS.find((t) => t.id === 'powmod')!;
    const limits = { maxSteps: target.steps(9), maxInstructions: 256, maxStack: 256, memorySlots: 32, maxMagnitude: Number.MAX_SAFE_INTEGER };
    const input = [7, 500_000, 9973];

    const slow = execute(naive, input, limits);
    assert.equal(slow.ok, false, 'naive powmod should exhaust the budget');

    const fast = execute(ultrasmInternals.REFERENCE['powmod']!, input, limits);
    assert.ok(fast.ok);
    assert.deepEqual(fast.ok ? fast.output : [], [target.fn(input)]);
  });
});

describe('verifyTask survives a broken family', () => {
  it('turns a thrown verifier into a failed answer, not a crashed race', () => {
    const task = generateYard('CRASH', rulesForHour(1)).tasks[0]!;
    const broken = { ...task, family: 'not-a-family' as never };
    const verdict = verifyTask(broken, 'anything');
    assert.equal(verdict.ok, false);
    assert.match(verdict.expected, /verifier error/);
  });
});
