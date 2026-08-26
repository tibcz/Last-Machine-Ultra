/**
 * ULTRASM - write a program, not an answer.
 *
 * The entrant submits ULTRA-ASM source. It is parsed, then run against hidden
 * test vectors on a step budget that tightens with tier. By the top tiers the
 * budget is the real adversary: `powmod` is unreachable by repeated
 * multiplication and `divisors` is unreachable by trial division to n, so a
 * correct-but-naive program fails on time exactly the way a runner does.
 */

import type { ChallengeModule, GenerateContext, Rng, Task, VerifyResult } from './deps.js';
import { byTier, buildTask, stripFences } from './util.js';
import { DEFAULT_LIMITS, execute, type VmLimits } from './vm.js';

interface Target {
  id: string;
  minTier: number;
  arity: number;
  /** Human description, shown in the prompt and used as the report's "expected". */
  describe: string;
  fn(args: number[]): number;
  sample(rng: Rng, tier: number): number[];
  /** Step budget at a given tier. */
  steps(tier: number): number;
}

const TARGETS: Target[] = [
  {
    id: 'affine',
    minTier: 0,
    arity: 1,
    describe: 'f(x) = 3x + 7',
    fn: ([x]) => 3 * x! + 7,
    sample: (rng) => [rng.int(-50, 50)],
    steps: () => 2_000,
  },
  {
    id: 'absdiff',
    minTier: 0,
    arity: 2,
    describe: 'f(a, b) = |a - b|',
    fn: ([a, b]) => Math.abs(a! - b!),
    sample: (rng) => [rng.int(-99, 99), rng.int(-99, 99)],
    steps: () => 2_000,
  },
  {
    id: 'spread',
    minTier: 2,
    arity: 3,
    describe: 'f(a, b, c) = max(a, b, c) - min(a, b, c)',
    fn: (args) => Math.max(...args) - Math.min(...args),
    sample: (rng) => [rng.int(-99, 99), rng.int(-99, 99), rng.int(-99, 99)],
    steps: () => 2_000,
  },
  {
    id: 'triangular',
    minTier: 2,
    arity: 1,
    describe: 'f(n) = 1 + 2 + ... + n, for n >= 1',
    fn: ([n]) => (n! * (n! + 1)) / 2,
    sample: (rng) => [rng.int(1, 400)],
    steps: (tier) => byTier(tier, 8_000, 4_000),
  },
  {
    id: 'digitsum',
    minTier: 4,
    arity: 1,
    describe: 'f(x) = the sum of the decimal digits of x, for x >= 0',
    fn: ([x]) =>
      String(x!)
        .split('')
        .reduce((sum, d) => sum + Number(d), 0),
    sample: (rng) => [rng.int(0, 999_999)],
    steps: (tier) => byTier(tier, 4_000, 2_000),
  },
  {
    id: 'gcd',
    minTier: 4,
    arity: 2,
    describe: 'f(a, b) = the greatest common divisor of a and b, for a, b >= 1',
    fn: ([a, b]) => {
      let x = a!;
      let y = b!;
      while (y) [x, y] = [y, x % y];
      return x;
    },
    sample: (rng) => [rng.int(1, 5_000), rng.int(1, 5_000)],
    steps: (tier) => byTier(tier, 6_000, 3_000),
  },
  {
    id: 'fib',
    minTier: 6,
    arity: 1,
    describe: 'f(n) = the n-th Fibonacci number, with f(0) = 0 and f(1) = 1',
    fn: ([n]) => {
      let a = 0;
      let b = 1;
      for (let i = 0; i < n!; i++) [a, b] = [b, a + b];
      return a;
    },
    sample: (rng) => [rng.int(0, 40)],
    steps: (tier) => byTier(tier, 5_000, 2_500),
  },
  {
    id: 'popcount',
    minTier: 6,
    arity: 1,
    describe: 'f(x) = how many 1 bits x has when written in binary, for x >= 0',
    fn: ([x]) => x!.toString(2).split('').filter((b) => b === '1').length,
    sample: (rng) => [rng.int(0, 1_000_000)],
    steps: (tier) => byTier(tier, 4_000, 2_000),
  },
  {
    id: 'powmod',
    minTier: 8,
    arity: 3,
    describe: 'f(a, b, m) = a raised to the power b, modulo m (b >= 0, m >= 2)',
    fn: ([a, b, m]) => {
      let result = 1;
      let base = a! % m!;
      let exp = b!;
      while (exp > 0) {
        if (exp % 2 === 1) result = (result * base) % m!;
        base = (base * base) % m!;
        exp = Math.floor(exp / 2);
      }
      return result;
    },
    sample: (rng) => [rng.int(2, 500), rng.int(1_000, 900_000), rng.int(97, 9_973)],
    // Deliberately below what repeated multiplication needs.
    steps: () => 2_500,
  },
  {
    id: 'divisors',
    minTier: 8,
    arity: 1,
    describe: 'f(x) = how many positive integers divide x exactly, for x >= 1',
    fn: ([x]) => {
      let count = 0;
      for (let d = 1; d * d <= x!; d++) {
        if (x! % d === 0) count += d * d === x! ? 1 : 2;
      }
      return count;
    },
    sample: (rng) => [rng.int(10_000, 200_000)],
    // Enough for a sqrt-bounded scan, nowhere near enough to try every divisor.
    steps: () => 30_000,
  },
];

/**
 * A working ULTRA-ASM program for every target.
 *
 * These exist for three reasons: the test suite runs them to prove each target
 * is actually reachable inside its step budget, simulated entrants submit them
 * when they "solve" a task, and `lmu yard --solutions` prints them so a team
 * can see what a passing answer looks like before writing their own.
 */
const REFERENCE: Record<string, string> = {
  affine: ['IN', 'PUSH 3', 'MUL', 'PUSH 7', 'ADD', 'OUT', 'HALT'].join('\n'),

  absdiff: ['IN', 'IN', 'SUB', 'DUP', 'PUSH 0', 'LT', 'JZ done', 'NEG', 'done:', 'OUT', 'HALT'].join('\n'),

  spread: [
    'IN', 'STORE 0', 'IN', 'STORE 1', 'IN', 'STORE 2',
    'LOAD 0', 'STORE 3',
    'LOAD 0', 'STORE 4',
    'LOAD 1', 'LOAD 3', 'GT', 'JZ s1', 'LOAD 1', 'STORE 3', 's1:',
    'LOAD 1', 'LOAD 4', 'LT', 'JZ s2', 'LOAD 1', 'STORE 4', 's2:',
    'LOAD 2', 'LOAD 3', 'GT', 'JZ s3', 'LOAD 2', 'STORE 3', 's3:',
    'LOAD 2', 'LOAD 4', 'LT', 'JZ s4', 'LOAD 2', 'STORE 4', 's4:',
    'LOAD 3', 'LOAD 4', 'SUB', 'OUT', 'HALT',
  ].join('\n'),

  triangular: ['IN', 'DUP', 'PUSH 1', 'ADD', 'MUL', 'PUSH 2', 'DIV', 'OUT', 'HALT'].join('\n'),

  digitsum: [
    'IN', 'STORE 0', 'PUSH 0', 'STORE 1',
    'loop:', 'LOAD 0', 'JZ done',
    'LOAD 0', 'PUSH 10', 'MOD', 'LOAD 1', 'ADD', 'STORE 1',
    'LOAD 0', 'PUSH 10', 'DIV', 'STORE 0', 'JMP loop',
    'done:', 'LOAD 1', 'OUT', 'HALT',
  ].join('\n'),

  gcd: [
    'IN', 'STORE 0', 'IN', 'STORE 1',
    'loop:', 'LOAD 1', 'JZ done',
    'LOAD 0', 'LOAD 1', 'MOD', 'STORE 2',
    'LOAD 1', 'STORE 0', 'LOAD 2', 'STORE 1', 'JMP loop',
    'done:', 'LOAD 0', 'OUT', 'HALT',
  ].join('\n'),

  fib: [
    'IN', 'STORE 0', 'PUSH 0', 'STORE 1', 'PUSH 1', 'STORE 2',
    'loop:', 'LOAD 0', 'JZ done',
    'LOAD 1', 'LOAD 2', 'ADD', 'STORE 3',
    'LOAD 2', 'STORE 1', 'LOAD 3', 'STORE 2',
    'LOAD 0', 'PUSH 1', 'SUB', 'STORE 0', 'JMP loop',
    'done:', 'LOAD 1', 'OUT', 'HALT',
  ].join('\n'),

  popcount: [
    'IN', 'STORE 0', 'PUSH 0', 'STORE 1',
    'loop:', 'LOAD 0', 'JZ done',
    'LOAD 0', 'PUSH 2', 'MOD', 'LOAD 1', 'ADD', 'STORE 1',
    'LOAD 0', 'PUSH 2', 'DIV', 'STORE 0', 'JMP loop',
    'done:', 'LOAD 1', 'OUT', 'HALT',
  ].join('\n'),

  // Square-and-multiply. Repeated multiplication cannot fit the step budget.
  powmod: [
    'IN', 'STORE 0', 'IN', 'STORE 1', 'IN', 'STORE 2',
    'PUSH 1', 'STORE 3',
    'LOAD 0', 'LOAD 2', 'MOD', 'STORE 0',
    'loop:', 'LOAD 1', 'JZ done',
    'LOAD 1', 'PUSH 2', 'MOD', 'JZ skip',
    'LOAD 3', 'LOAD 0', 'MUL', 'LOAD 2', 'MOD', 'STORE 3',
    'skip:',
    'LOAD 0', 'LOAD 0', 'MUL', 'LOAD 2', 'MOD', 'STORE 0',
    'LOAD 1', 'PUSH 2', 'DIV', 'STORE 1', 'JMP loop',
    'done:', 'LOAD 3', 'OUT', 'HALT',
  ].join('\n'),

  // Scan to sqrt(x), counting each divisor pair once.
  divisors: [
    'IN', 'STORE 0', 'PUSH 0', 'STORE 1', 'PUSH 1', 'STORE 2',
    'loop:',
    'LOAD 2', 'LOAD 2', 'MUL', 'LOAD 0', 'GT', 'JNZ done',
    'LOAD 0', 'LOAD 2', 'MOD', 'JNZ next',
    'LOAD 1', 'PUSH 2', 'ADD', 'STORE 1',
    'LOAD 2', 'LOAD 2', 'MUL', 'LOAD 0', 'EQ', 'JZ next',
    'LOAD 1', 'PUSH 1', 'SUB', 'STORE 1',
    'next:',
    'LOAD 2', 'PUSH 1', 'ADD', 'STORE 2', 'JMP loop',
    'done:', 'LOAD 1', 'OUT', 'HALT',
  ].join('\n'),
};

interface Secret {
  targetId: string;
  describe: string;
  arity: number;
  vectors: Array<{ input: number[]; expected: number }>;
  limits: VmLimits;
  /** A known-good program. Used by the test suite and by simulated entrants. */
  reference: string;
}

const ISA = [
  'PUSH n     push the integer n',
  'DUP        duplicate the top value',
  'DROP       discard the top value',
  'SWAP       exchange the top two values',
  'OVER       copy the second value to the top',
  'ADD SUB MUL DIV MOD    pop b, pop a, push a OP b (DIV truncates toward zero)',
  'NEG        negate the top value',
  'LT GT EQ   pop b, pop a, push 1 if a<b / a>b / a==b, else 0',
  'NOT        push 1 if the top value is 0, else 0',
  'LOAD i     push memory slot i',
  'STORE i    pop into memory slot i',
  'name:      define a jump label',
  'JMP L      jump to label L',
  'JZ L       pop; jump to L if it was 0',
  'JNZ L      pop; jump to L if it was not 0',
  'IN         push the next input value',
  'OUT        pop and emit it as output',
  'HALT       stop',
];

export const ultrasm: ChallengeModule = {
  family: 'ultrasm',
  blurb: 'Write an ULTRA-ASM program. It is run against hidden vectors on a step budget.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards } = ctx;

    const available = TARGETS.filter((t) => t.minTier <= tier);
    const hardest = Math.max(...available.map((t) => t.minTier));
    // Bias hard: at a given tier the newly unlocked targets are the point.
    const pool = available.filter((t) => t.minTier >= hardest - 2);
    const target = rng.pick(pool);

    const limits: VmLimits = { ...DEFAULT_LIMITS, maxSteps: target.steps(tier) };

    const vectorCount = byTier(tier, 4, 8);
    const vectors = Array.from({ length: vectorCount }, () => {
      const input = target.sample(rng, tier);
      return { input, expected: target.fn(input) };
    });

    const shown = vectors.slice(0, 2);

    const head = hazards.includes('terse')
      ? 'ULTRA-ASM. one program. reads all inputs, emits exactly one value.'
      : [
          'Write a program in ULTRA-ASM, a small stack machine.',
          '',
          `Your program is run once per test case. It must read all ${target.arity} input`,
          'value(s) with IN, in order, and emit exactly one value with OUT.',
        ].join('\n');

    const prompt = [
      head,
      '',
      'INSTRUCTION SET',
      ...ISA.map((l) => `  ${l}`),
      '',
      'LIMITS',
      `  ${limits.maxInstructions} instructions, ${limits.maxSteps} execution steps,`,
      `  stack depth ${limits.maxStack}, memory slots 0-${limits.memorySlots - 1} (all start at 0).`,
      '  Exceeding any limit fails the task.',
      '',
      'COMPUTE',
      `  ${target.describe}`,
      '',
      'EXAMPLES',
      ...shown.map((v) => `  input ${v.input.join(' ')}  ->  output ${v.expected}`),
      '',
      'Submit the program source and nothing else.',
    ].join('\n');

    const secret: Secret = {
      targetId: target.id,
      describe: target.describe,
      arity: target.arity,
      vectors,
      limits,
      reference: REFERENCE[target.id] ?? '',
    };

    return buildTask(ctx, 'ultrasm', prompt, 'ULTRA-ASM source, one instruction per line.', secret);
  },

  verify(task: Task, raw: string): VerifyResult {
    const secret = task.secret as Secret;
    const source = stripFences(raw ?? '');
    const preview = source.replace(/\s+/g, ' ').trim();
    const got = preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
    const expected = secret.describe;

    if (source.length === 0) {
      return { ok: false, expected, got, note: 'empty submission' };
    }

    // `no_scratch` cannot mean "one line" for a program. It means no commentary:
    // the source has to stand on its own.
    if (task.hazards.includes('no_scratch') && /[;#]/.test(source)) {
      return { ok: false, expected, got, note: 'no_scratch: program contains comments' };
    }

    for (const vector of secret.vectors) {
      const result = execute(source, vector.input, secret.limits);
      if (!result.ok) {
        return {
          ok: false,
          expected,
          got,
          note: `input [${vector.input.join(', ')}]: ${result.error}`,
        };
      }
      if (result.output.length !== 1) {
        return {
          ok: false,
          expected,
          got,
          note: `input [${vector.input.join(', ')}]: emitted ${result.output.length} values, wanted exactly 1`,
        };
      }
      if (result.output[0] !== vector.expected) {
        return {
          ok: false,
          expected,
          got,
          note: `input [${vector.input.join(', ')}]: got ${result.output[0]}, wanted ${vector.expected}`,
        };
      }
    }

    return { ok: true, expected, got, note: `${secret.vectors.length} vectors passed` };
  },
};

export const ultrasmInternals = { TARGETS, REFERENCE };
