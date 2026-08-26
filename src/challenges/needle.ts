/**
 * NEEDLE - find the relevant lines in a wall of telemetry, then compute over them.
 *
 * Retrieval alone is not the test. Anything can grep. The test is retrieval
 * plus exact arithmetic over what was retrieved, at an hour when the token
 * budget no longer stretches to reading the haystack twice. Haystacks grow with
 * tier, matching conditions multiply, and from tier 7 the quantity being summed
 * is derived rather than printed.
 */

import type { ChallengeModule, GenerateContext, Rng, Task } from './deps.js';
import { byTier, buildTask, mark } from './util.js';

interface Line {
  index: number;
  node: string;
  state: string;
  temp: number;
  load: number;
}

interface Secret {
  matching: Line[];
  question: string;
  answer: string;
  kind: 'int' | 'text';
}

const STATES = ['IDLE', 'FAULT', 'SYNC', 'DRAIN', 'HOLD'];

function renderLine(l: Line): string {
  const stamp = `T${String(l.index).padStart(4, '0')}`;
  return `${stamp}  ${l.node}  state=${l.state.padEnd(5)} temp=${String(l.temp).padStart(3)} load=${String(l.load).padStart(3)}`;
}

export const needle: ChallengeModule = {
  family: 'needle',
  blurb: 'Pull the matching records out of a long telemetry dump and compute over them.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards } = ctx;

    const lineCount = byTier(tier, 40, 320);
    const nodes = Array.from({ length: byTier(tier, 4, 9) }, (_, i) => `NODE-${String.fromCharCode(65 + i)}${rng.int(10, 99)}`);

    const lines: Line[] = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push({
        index: i + 1,
        node: rng.pick(nodes),
        state: rng.pick(STATES),
        temp: rng.int(10, 99),
        load: rng.int(0, 199),
      });
    }

    // Pick a condition that actually matches something, then describe it.
    const targetNode = rng.pick(nodes);
    const targetState = rng.pick(STATES);
    const twoConditions = tier >= 5;

    let matching = lines.filter(
      (l) => l.node === targetNode && (!twoConditions || l.state === targetState),
    );
    let conditionText = twoConditions
      ? `node ${targetNode} AND state=${targetState}`
      : `node ${targetNode}`;

    // Guarantee at least two matches by falling back to the looser condition.
    if (matching.length < 2) {
      matching = lines.filter((l) => l.node === targetNode);
      conditionText = `node ${targetNode}`;
    }
    if (matching.length < 2) {
      matching = lines.filter((l) => l.state === targetState);
      conditionText = `state=${targetState}`;
    }

    const derived = tier >= 7;
    const measure = derived ? 'load minus temp' : rng.pick(['load', 'temp']);
    const valueOf = (l: Line) => (derived ? l.load - l.temp : measure === 'load' ? l.load : l.temp);

    const shape = rng.pick(['sum', 'count', 'peak'] as const);

    let question: string;
    let answer: string;
    let kind: 'int' | 'text';

    switch (shape) {
      case 'sum': {
        question = `What is the total ${measure} across every record with ${conditionText}?`;
        answer = String(matching.reduce((sum, l) => sum + valueOf(l), 0));
        kind = 'int';
        break;
      }
      case 'count': {
        question = `How many records have ${conditionText}?`;
        answer = String(matching.length);
        kind = 'int';
        break;
      }
      case 'peak': {
        const best = matching.reduce((a, b) => (valueOf(b) > valueOf(a) ? b : a));
        question = `Among records with ${conditionText}, which timestamp has the highest ${measure}? If two tie, give the earliest.`;
        answer = `T${String(best.index).padStart(4, '0')}`;
        kind = 'text';
        break;
      }
    }

    const head = hazards.includes('terse') ? 'LOG' : 'Telemetry dump, one record per line:';

    const prompt = [head, '', ...lines.map(renderLine), '', question].join('\n');

    const secret: Secret = { matching, question, answer, kind };
    return buildTask(
      ctx,
      'needle',
      prompt,
      kind === 'int' ? 'A single integer.' : 'A single timestamp, e.g. T0042.',
      secret,
    );
  },

  verify(task: Task, raw: string) {
    const secret = task.secret as Secret;
    return mark(task, raw, secret.answer, secret.kind, task.hazards);
  },
};
