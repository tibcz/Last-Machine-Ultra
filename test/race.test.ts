import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InstantClock } from '../src/core/clock.js';
import { Race } from '../src/core/race.js';
import type { Submission, YardBrief } from '../src/core/types.js';
import type { RunContext, SimulatedCompetitor } from '../src/competitors/types.js';

type Move = 'pass' | 'fail' | 'late' | 'throw';

/**
 * An entrant with a script. Everything the engine decides is a function of
 * whether an entrant finished a yard, so being able to say "pass, pass, then
 * miss the cutoff" is all a rules test needs.
 */
class Scripted implements SimulatedCompetitor {
  readonly simulated = true;
  readonly kind = 'test:scripted';

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly plan: Move[],
    readonly team = `team-${id}`,
    readonly teamSlug = `team-${id}`,
  ) {}

  private moveFor(hour: number): Move {
    return this.plan[hour - 1] ?? this.plan[this.plan.length - 1] ?? 'pass';
  }

  async runSimulated(
    brief: YardBrief,
    solutions: Readonly<Record<string, string>>,
  ): Promise<Submission> {
    const move = this.moveFor(brief.hour);
    if (move === 'throw') throw new Error('adapter exploded');

    const answers: Record<string, string> = {};
    for (const task of brief.tasks) {
      answers[task.id] = move === 'fail' ? 'nope' : (solutions[task.id] ?? '');
    }

    return {
      answers,
      elapsedMs: move === 'late' ? brief.cutoffMs + 1 : Math.round(brief.cutoffMs / 2),
    };
  }

  async run(brief: YardBrief, _ctx: RunContext): Promise<Submission> {
    return this.runSimulated(brief, {});
  }
}

const race = (competitors: SimulatedCompetitor[], maxHours = 10) =>
  new Race({ seed: 'RULES', competitors, clock: new InstantClock(), maxHours });

describe('the finishing rules', () => {
  it('the sole finisher of a contested yard wins immediately', async () => {
    const summary = await race([
      new Scripted('a', 'Alpha', ['pass']),
      new Scripted('b', 'Bravo', ['fail']),
    ]).run();

    assert.equal(summary.winner?.id, 'a');
    assert.equal(summary.winner?.yards, 1);
    assert.equal(summary.noWinner, false);
    // The rule is "one more yard than anyone else", and after hour 1 that is
    // already true. There is no extra solo lap to run.
    assert.equal(summary.hour, 1);
  });

  it('nobody wins when the whole corral fails the same yard', async () => {
    const summary = await race([
      new Scripted('a', 'Alpha', ['pass', 'fail']),
      new Scripted('b', 'Bravo', ['pass', 'fail']),
    ]).run();

    assert.equal(summary.winner, undefined);
    assert.equal(summary.noWinner, true);
    assert.equal(summary.hour, 2);
    for (const entrant of summary.entrants) {
      assert.equal(entrant.status, 'no_winner');
      assert.equal(entrant.yards, 1);
    }
  });

  it('keeps going while more than one entrant is still finishing', async () => {
    const engine = race(
      [
        new Scripted('a', 'Alpha', ['pass', 'pass', 'pass', 'fail']),
        new Scripted('b', 'Bravo', ['pass', 'pass', 'pass', 'pass']),
      ],
      10,
    );
    const summary = await engine.run();

    assert.equal(summary.hour, 4);
    assert.equal(summary.winner?.id, 'b');
    assert.equal(summary.winner?.yards, 4);
    assert.equal(engine.reports.length, 4);
  });

  it('awards the assist to the strongest entrant knocked out at the end', async () => {
    const summary = await race([
      new Scripted('a', 'Alpha', ['pass', 'pass', 'pass']),
      new Scripted('b', 'Bravo', ['pass', 'pass', 'fail']),
      new Scripted('c', 'Cera', ['fail']),
    ]).run();

    assert.equal(summary.winner?.id, 'a');
    assert.equal(summary.assist?.id, 'b', 'the assist is the last one out, not the first');
    assert.equal(summary.entrants.find((e) => e.id === 'c')?.assist, undefined);
  });

  it('runs a solo entry as a time trial with no winner', async () => {
    const summary = await race([new Scripted('a', 'Alpha', ['pass', 'pass', 'fail'])]).run();

    assert.equal(summary.winner, undefined, 'you cannot win a race you are the only one in');
    assert.equal(summary.entrants[0]?.yards, 2);
    assert.equal(summary.hour, 3);
  });

  it('stops at maxHours without declaring anyone', async () => {
    const summary = await race(
      [new Scripted('a', 'Alpha', ['pass']), new Scripted('b', 'Bravo', ['pass'])],
      3,
    ).run();

    assert.equal(summary.hour, 3);
    assert.equal(summary.winner, undefined);
    assert.equal(summary.noWinner, false);
    assert.equal(summary.entrants.every((e) => e.yards === 3), true);
  });
});

describe('why an entrant went out', () => {
  it('records a missed cutoff separately from a wrong answer', async () => {
    const summary = await race([
      new Scripted('a', 'Alpha', ['pass', 'pass']),
      new Scripted('b', 'Bravo', ['late']),
      new Scripted('c', 'Cera', ['fail']),
    ]).run();

    const byId = new Map(summary.entrants.map((e) => [e.id, e]));
    assert.equal(byId.get('b')?.outReason, 'missed_cutoff');
    assert.equal(byId.get('c')?.outReason, 'wrong_answer');
  });

  it('treats an adapter that throws as an elimination, not a crash', async () => {
    const summary = await race([
      new Scripted('a', 'Alpha', ['pass', 'pass']),
      new Scripted('b', 'Bravo', ['throw']),
    ]).run();

    const bravo = summary.entrants.find((e) => e.id === 'b');
    assert.equal(bravo?.outReason, 'error');
    assert.equal(summary.winner?.id, 'a');
  });

  it('counts a correct answer submitted after the cutoff as a DNF', async () => {
    const engine = race([
      new Scripted('a', 'Alpha', ['pass', 'pass']),
      new Scripted('b', 'Bravo', ['late']),
    ]);
    await engine.run();

    const result = engine.reports[0]!.results.find((r) => r.entrantId === 'b')!;
    assert.equal(result.finished, false);
    assert.equal(
      result.outcomes.every((o) => o.ok),
      true,
      'the answers were right - the clock was the problem',
    );
  });
});

describe('events and reproducibility', () => {
  it('emits the race in order', async () => {
    const seen: string[] = [];
    const engine = race([
      new Scripted('a', 'Alpha', ['pass']),
      new Scripted('b', 'Bravo', ['fail']),
    ]);
    engine.on('race:start', () => seen.push('start'));
    engine.on('bell', () => seen.push('bell'));
    engine.on('entrant:out', () => seen.push('out'));
    engine.on('yard:end', () => seen.push('yard'));
    engine.on('race:end', () => seen.push('end'));

    await engine.run();
    assert.deepEqual(seen, ['start', 'bell', 'out', 'yard', 'end']);
  });

  it('gives the same result twice for the same seed and field', async () => {
    const { makeLocalBot } = await import('../src/competitors/local.js');
    const build = () =>
      ['pacer', 'sprinter', 'grinder', 'spark'].map((bot, i) =>
        makeLocalBot({
          id: `e${i}`,
          name: bot,
          team: bot,
          teamSlug: bot,
          bot,
          seed: 'REPRO',
        }),
      );

    const first = await new Race({ seed: 'REPRO', competitors: build() }).run();
    const second = await new Race({ seed: 'REPRO', competitors: build() }).run();

    assert.equal(first.hour, second.hour);
    assert.equal(first.winner?.id, second.winner?.id);
    assert.deepEqual(
      first.entrants.map((e) => [e.id, e.yards, e.outAtHour, e.outReason]),
      second.entrants.map((e) => [e.id, e.yards, e.outAtHour, e.outReason]),
    );
  });

  it('a race that ends still reports a coherent summary', async () => {
    const engine = race([
      new Scripted('a', 'Alpha', ['pass', 'pass']),
      new Scripted('b', 'Bravo', ['pass', 'fail']),
    ]);
    const summary = await engine.run();

    assert.equal(summary.status, 'finished');
    assert.ok(summary.finishedAt !== undefined);
    assert.equal(summary.teams.length, 2);
    assert.equal(summary.teams[0]?.won, true);
    assert.equal(summary.teams[0]?.bestYards, 2);
  });
});
