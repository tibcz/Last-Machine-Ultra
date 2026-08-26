/**
 * MODCHAIN - a pipeline of modular operations applied to a starting value.
 *
 * Nothing here is clever. It is a long, exact, order-dependent computation with
 * no shortcuts, which is precisely the sort of thing that goes wrong at hour 30
 * on a shrinking token budget. Chains get longer and the operator set gets
 * nastier with tier; under `decoys` the chain grows disabled steps that must be
 * skipped.
 */

import type { ChallengeModule, GenerateContext, Rng, Task } from './deps.js';
import { byTier, formatHint, frame, mark } from './util.js';

type Op =
  | { kind: 'add'; k: number }
  | { kind: 'sub'; k: number }
  | { kind: 'mul'; k: number }
  | { kind: 'xor'; k: number }
  | { kind: 'pow'; k: number }
  | { kind: 'gcd'; k: number }
  | { kind: 'digitsum' }
  | { kind: 'reverse' };

interface Step {
  op: Op;
  enabled: boolean;
}

interface Secret {
  start: number;
  modulus: number;
  steps: Step[];
  answer: number;
}

function modPow(base: number, exp: number, mod: number): number {
  let result = 1;
  let b = base % mod;
  let e = exp;
  while (e > 0) {
    if (e & 1) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1;
  }
  return result;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

function applyOp(value: number, op: Op, modulus: number): number {
  let next: number;
  switch (op.kind) {
    case 'add':
      next = value + op.k;
      break;
    case 'sub':
      next = value - op.k;
      break;
    case 'mul':
      next = value * op.k;
      break;
    case 'xor':
      next = (value ^ op.k) >>> 0;
      break;
    case 'pow':
      next = modPow(value, op.k, modulus);
      break;
    case 'gcd':
      next = gcd(value, op.k);
      break;
    case 'digitsum':
      next = String(Math.abs(value))
        .split('')
        .reduce((sum, d) => sum + Number(d), 0);
      break;
    case 'reverse':
      next = Number(String(Math.abs(value)).split('').reverse().join(''));
      break;
  }
  return ((next % modulus) + modulus) % modulus;
}

function renderOp(op: Op): string {
  switch (op.kind) {
    case 'add':
      return `ADD ${op.k}`;
    case 'sub':
      return `SUB ${op.k}`;
    case 'mul':
      return `MUL ${op.k}`;
    case 'xor':
      return `XOR ${op.k}`;
    case 'pow':
      return `POW ${op.k}`;
    case 'gcd':
      return `GCD ${op.k}`;
    case 'digitsum':
      return 'DIGITSUM';
    case 'reverse':
      return 'REVERSE';
  }
}

function opPool(tier: number): Array<Op['kind']> {
  const pool: Array<Op['kind']> = ['add', 'sub', 'mul'];
  if (tier >= 2) pool.push('xor', 'pow');
  if (tier >= 5) pool.push('digitsum', 'reverse', 'gcd');
  return pool;
}

function makeOp(rng: Rng, tier: number, modulus: number): Op {
  const kind = rng.pick(opPool(tier));
  switch (kind) {
    case 'add':
    case 'sub':
      return { kind, k: rng.int(2, Math.max(9, Math.floor(modulus / 3))) };
    case 'mul':
      return { kind, k: rng.int(2, byTier(tier, 12, 97)) };
    case 'xor':
      return { kind, k: rng.int(1, 255) };
    case 'pow':
      return { kind, k: rng.int(2, byTier(tier, 4, 11)) };
    case 'gcd':
      return { kind, k: rng.int(6, 720) };
    default:
      return { kind: kind as 'digitsum' | 'reverse' };
  }
}

export const modchain: ChallengeModule = {
  family: 'modchain',
  blurb: 'Run a value through a pipeline of modular operations. No shortcuts, no partial credit.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards, id } = ctx;
    const modulus = rng.pick([97, 251, 997, 4093, 65_521, 1_000_003].slice(0, byTier(tier, 2, 6)));
    const start = rng.int(2, modulus - 1);
    const length = byTier(tier, 3, 16);

    const steps: Step[] = [];
    for (let i = 0; i < length; i++) {
      steps.push({ op: makeOp(rng, tier, modulus), enabled: true });
    }

    // Decoys here are not noise bolted on the side - they are extra steps in
    // the chain itself, marked disabled. Read carelessly, run them, get a
    // wrong number that looks entirely reasonable.
    if (hazards.includes('decoys')) {
      const decoyCount = 1 + Math.floor(tier / 3);
      for (let i = 0; i < decoyCount; i++) {
        const at = rng.int(0, steps.length);
        steps.splice(at, 0, { op: makeOp(rng, tier, modulus), enabled: false });
      }
    }

    let value = start;
    for (const step of steps) {
      if (step.enabled) value = applyOp(value, step.op, modulus);
    }

    const listing = steps
      .map((s, i) => {
        const label = `${String(i + 1).padStart(2, ' ')}. ${renderOp(s.op)}`;
        return s.enabled ? label : `${label}   [DISABLED]`;
      })
      .join('\n');

    const intro = frame(
      hazards,
      `Start with ${start}. Apply each ENABLED step in order, taking the result modulo ${modulus} after every step. Steps marked [DISABLED] are skipped entirely.`,
      `START ${start}  MOD ${modulus}  (skip [DISABLED])`,
    );

    const prompt = `${intro}\n\n${listing}\n\nWhat is the final value?`;

    const secret: Secret = { start, modulus, steps, answer: value };
    const task: Task = {
      id,
      family: 'modchain',
      tier,
      prompt,
      hazards: [...hazards],
      secret,
    };
    const hint = formatHint(hazards, 'A single integer.');
    if (hint) task.answerFormat = hint;
    return task;
  },

  verify(task: Task, raw: string) {
    const secret = task.secret as Secret;
    return mark(task, raw, String(secret.answer), 'int', task.hazards);
  },
};
