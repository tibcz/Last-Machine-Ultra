/**
 * ULTRA-ASM: a very small stack machine.
 *
 * The ULTRASM challenge family asks entrants to write programs, and those
 * programs have to actually run to be marked. This interpreter is the whole
 * execution environment: integers only, a bounded stack, 32 memory slots, a
 * fixed input queue, and a step budget. It has no access to anything outside
 * itself - no host objects, no I/O, no clock, no way to allocate - so running
 * a submitted program is arithmetic, not code execution.
 *
 * Everything is bounded, so a hostile or merely broken program terminates:
 * steps, stack depth, program length and integer range all have hard ceilings.
 */

export const OPCODES = [
  'PUSH',
  'DUP',
  'DROP',
  'SWAP',
  'OVER',
  'ADD',
  'SUB',
  'MUL',
  'DIV',
  'MOD',
  'NEG',
  'LT',
  'GT',
  'EQ',
  'NOT',
  'LOAD',
  'STORE',
  'JMP',
  'JZ',
  'JNZ',
  'IN',
  'OUT',
  'HALT',
] as const;

export type Opcode = (typeof OPCODES)[number];

export interface VmLimits {
  maxSteps: number;
  maxInstructions: number;
  maxStack: number;
  memorySlots: number;
  /** Absolute value ceiling; exceeding it is an error, not a wrap. */
  maxMagnitude: number;
}

export const DEFAULT_LIMITS: VmLimits = {
  maxSteps: 20_000,
  maxInstructions: 256,
  maxStack: 256,
  memorySlots: 32,
  maxMagnitude: Number.MAX_SAFE_INTEGER,
};

interface Instruction {
  op: Opcode;
  arg?: number;
  label?: string;
  line: number;
}

export interface Program {
  instructions: Instruction[];
  labels: Map<string, number>;
  /** True if the source carried any comment. Hazards care about this. */
  hasComments: boolean;
}

export type ParseResult = { ok: true; program: Program } | { ok: false; error: string };

export type RunResult =
  | { ok: true; output: number[]; steps: number }
  | { ok: false; error: string; steps: number };

const LABEL_DEF = /^([A-Za-z_][A-Za-z0-9_]*):$/;
const NEEDS_INT_ARG = new Set<Opcode>(['PUSH', 'LOAD', 'STORE']);
const NEEDS_LABEL_ARG = new Set<Opcode>(['JMP', 'JZ', 'JNZ']);

export function parse(source: string, limits: VmLimits = DEFAULT_LIMITS): ParseResult {
  const stripped = source
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '');

  const instructions: Instruction[] = [];
  const labels = new Map<string, number>();
  let hasComments = false;

  const rawLines = stripped.split('\n');
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const commentAt = raw.search(/[;#]/);
    if (commentAt >= 0) hasComments = true;
    const line = (commentAt >= 0 ? raw.slice(0, commentAt) : raw).trim();
    if (line.length === 0) continue;

    const labelMatch = line.match(LABEL_DEF);
    if (labelMatch) {
      const name = labelMatch[1]!;
      if (labels.has(name)) return { ok: false, error: `duplicate label "${name}" on line ${i + 1}` };
      labels.set(name, instructions.length);
      continue;
    }

    const [head, ...rest] = line.split(/\s+/);
    const op = head!.toUpperCase() as Opcode;
    if (!OPCODES.includes(op)) {
      return { ok: false, error: `unknown opcode "${head}" on line ${i + 1}` };
    }
    if (rest.length > 1) {
      return { ok: false, error: `too many operands for ${op} on line ${i + 1}` };
    }

    const instruction: Instruction = { op, line: i + 1 };

    if (NEEDS_INT_ARG.has(op)) {
      const value = Number(rest[0]);
      if (rest.length !== 1 || !Number.isInteger(value)) {
        return { ok: false, error: `${op} needs an integer operand (line ${i + 1})` };
      }
      if (op !== 'PUSH' && (value < 0 || value >= limits.memorySlots)) {
        return {
          ok: false,
          error: `${op} slot must be 0..${limits.memorySlots - 1} (line ${i + 1})`,
        };
      }
      instruction.arg = value;
    } else if (NEEDS_LABEL_ARG.has(op)) {
      if (rest.length !== 1) return { ok: false, error: `${op} needs a label (line ${i + 1})` };
      instruction.label = rest[0]!;
    } else if (rest.length !== 0) {
      return { ok: false, error: `${op} takes no operand (line ${i + 1})` };
    }

    instructions.push(instruction);
    if (instructions.length > limits.maxInstructions) {
      return { ok: false, error: `program exceeds ${limits.maxInstructions} instructions` };
    }
  }

  if (instructions.length === 0) return { ok: false, error: 'program is empty' };

  for (const instruction of instructions) {
    if (instruction.label !== undefined && !labels.has(instruction.label)) {
      return {
        ok: false,
        error: `jump to undefined label "${instruction.label}" (line ${instruction.line})`,
      };
    }
  }

  return { ok: true, program: { instructions, labels, hasComments } };
}

export function run(program: Program, input: number[], limits: VmLimits = DEFAULT_LIMITS): RunResult {
  const stack: number[] = [];
  const memory = new Array<number>(limits.memorySlots).fill(0);
  const output: number[] = [];
  const queue = input.slice();
  let pc = 0;
  let steps = 0;

  const fail = (error: string): RunResult => ({ ok: false, error, steps });

  const pop = (): number | undefined => stack.pop();

  const push = (value: number): string | undefined => {
    if (!Number.isFinite(value) || Math.abs(value) > limits.maxMagnitude) {
      return 'integer overflow';
    }
    if (stack.length >= limits.maxStack) return 'stack overflow';
    stack.push(value);
    return undefined;
  };

  while (pc >= 0 && pc < program.instructions.length) {
    if (++steps > limits.maxSteps) return fail(`step budget of ${limits.maxSteps} exhausted`);

    const instruction = program.instructions[pc]!;
    const { op } = instruction;
    pc++;

    // Arity check up front, so every handler below can trust its operands.
    const needs: Partial<Record<Opcode, number>> = {
      DUP: 1,
      DROP: 1,
      SWAP: 2,
      OVER: 2,
      ADD: 2,
      SUB: 2,
      MUL: 2,
      DIV: 2,
      MOD: 2,
      NEG: 1,
      LT: 2,
      GT: 2,
      EQ: 2,
      NOT: 1,
      STORE: 1,
      JZ: 1,
      JNZ: 1,
      OUT: 1,
    };
    const required = needs[op] ?? 0;
    if (stack.length < required) return fail(`stack underflow at ${op} (line ${instruction.line})`);

    let overflow: string | undefined;

    switch (op) {
      case 'PUSH':
        overflow = push(instruction.arg!);
        break;
      case 'DUP':
        overflow = push(stack[stack.length - 1]!);
        break;
      case 'DROP':
        pop();
        break;
      case 'SWAP': {
        const a = pop()!;
        const b = pop()!;
        stack.push(a, b);
        break;
      }
      case 'OVER':
        overflow = push(stack[stack.length - 2]!);
        break;
      case 'ADD': {
        const b = pop()!;
        const a = pop()!;
        overflow = push(a + b);
        break;
      }
      case 'SUB': {
        const b = pop()!;
        const a = pop()!;
        overflow = push(a - b);
        break;
      }
      case 'MUL': {
        const b = pop()!;
        const a = pop()!;
        overflow = push(a * b);
        break;
      }
      case 'DIV': {
        const b = pop()!;
        const a = pop()!;
        if (b === 0) return fail(`division by zero (line ${instruction.line})`);
        overflow = push(Math.trunc(a / b));
        break;
      }
      case 'MOD': {
        const b = pop()!;
        const a = pop()!;
        if (b === 0) return fail(`modulo by zero (line ${instruction.line})`);
        overflow = push(a - Math.trunc(a / b) * b);
        break;
      }
      case 'NEG':
        overflow = push(-pop()!);
        break;
      case 'LT': {
        const b = pop()!;
        const a = pop()!;
        overflow = push(a < b ? 1 : 0);
        break;
      }
      case 'GT': {
        const b = pop()!;
        const a = pop()!;
        overflow = push(a > b ? 1 : 0);
        break;
      }
      case 'EQ': {
        const b = pop()!;
        const a = pop()!;
        overflow = push(a === b ? 1 : 0);
        break;
      }
      case 'NOT':
        overflow = push(pop() === 0 ? 1 : 0);
        break;
      case 'LOAD':
        overflow = push(memory[instruction.arg!]!);
        break;
      case 'STORE':
        memory[instruction.arg!] = pop()!;
        break;
      case 'JMP':
        pc = program.labels.get(instruction.label!)!;
        break;
      case 'JZ':
        if (pop() === 0) pc = program.labels.get(instruction.label!)!;
        break;
      case 'JNZ':
        if (pop() !== 0) pc = program.labels.get(instruction.label!)!;
        break;
      case 'IN': {
        if (queue.length === 0) return fail(`IN with no input left (line ${instruction.line})`);
        overflow = push(queue.shift()!);
        break;
      }
      case 'OUT':
        output.push(pop()!);
        if (output.length > limits.maxStack) return fail('too much output');
        break;
      case 'HALT':
        return { ok: true, output, steps };
    }

    if (overflow) return fail(`${overflow} at ${op} (line ${instruction.line})`);
  }

  return { ok: true, output, steps };
}

/** Parse and run in one go. */
export function execute(source: string, input: number[], limits: VmLimits = DEFAULT_LIMITS): RunResult & { program?: Program } {
  const parsed = parse(source, limits);
  if (!parsed.ok) return { ok: false, error: parsed.error, steps: 0 };
  return { ...run(parsed.program, input, limits), program: parsed.program };
}
