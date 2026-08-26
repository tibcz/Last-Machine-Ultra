import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_LIMITS, execute, parse, run } from '../src/challenges/vm.js';

const tight = { ...DEFAULT_LIMITS, maxSteps: 200 };

function output(source: string, input: number[] = [], limits = DEFAULT_LIMITS): number[] {
  const result = execute(source, input, limits);
  assert.ok(result.ok, `expected success, got: ${result.ok ? '' : result.error}`);
  return result.ok ? result.output : [];
}

function failure(source: string, input: number[] = [], limits = DEFAULT_LIMITS): string {
  const result = execute(source, input, limits);
  assert.equal(result.ok, false, 'expected the program to fail');
  return result.ok ? '' : result.error;
}

describe('ULTRA-ASM parsing', () => {
  it('ignores comments and blank lines, and records that comments were present', () => {
    const parsed = parse('; a note\n\nPUSH 1  # trailing\nOUT\nHALT\n');
    assert.ok(parsed.ok);
    assert.equal(parsed.ok && parsed.program.instructions.length, 3);
    assert.equal(parsed.ok && parsed.program.hasComments, true);
  });

  it('rejects unknown opcodes, bad operands and undefined labels', () => {
    assert.match(failure('FROBNICATE\nHALT'), /unknown opcode/);
    assert.match(failure('PUSH\nHALT'), /integer operand/);
    assert.match(failure('PUSH 1 2\nHALT'), /too many operands/);
    assert.match(failure('DUP 3\nHALT'), /takes no operand/);
    assert.match(failure('JMP nowhere\nHALT'), /undefined label/);
    assert.match(failure('LOAD 99\nHALT'), /slot must be/);
    assert.match(failure('a:\na:\nHALT'), /duplicate label/);
    assert.match(failure(''), /empty/);
  });

  it('accepts a fenced program, because models emit fences', () => {
    assert.deepEqual(output('```\nPUSH 42\nOUT\nHALT\n```'), [42]);
  });
});

describe('ULTRA-ASM execution', () => {
  it('does arithmetic with the documented operand order', () => {
    // Every binary op pops b then a and pushes `a OP b`.
    assert.deepEqual(output('PUSH 10\nPUSH 3\nSUB\nOUT\nHALT'), [7]);
    assert.deepEqual(output('PUSH 10\nPUSH 3\nDIV\nOUT\nHALT'), [3]);
    assert.deepEqual(output('PUSH -10\nPUSH 3\nDIV\nOUT\nHALT'), [-3], 'DIV truncates toward zero');
    assert.deepEqual(output('PUSH -10\nPUSH 3\nMOD\nOUT\nHALT'), [-1]);
    assert.deepEqual(output('PUSH 2\nPUSH 5\nLT\nOUT\nHALT'), [1]);
    assert.deepEqual(output('PUSH 2\nPUSH 5\nGT\nOUT\nHALT'), [0]);
  });

  it('moves values around the stack', () => {
    assert.deepEqual(output('PUSH 1\nPUSH 2\nSWAP\nOUT\nOUT\nHALT'), [1, 2]);
    assert.deepEqual(output('PUSH 7\nDUP\nADD\nOUT\nHALT'), [14]);
    assert.deepEqual(output('PUSH 3\nPUSH 9\nOVER\nOUT\nHALT'), [3]);
    assert.deepEqual(output('PUSH 1\nPUSH 2\nDROP\nOUT\nHALT'), [1]);
  });

  it('reads input in order and keeps memory across jumps', () => {
    const sum = ['PUSH 0', 'STORE 0', 'IN', 'LOAD 0', 'ADD', 'STORE 0', 'IN', 'LOAD 0', 'ADD', 'STORE 0', 'LOAD 0', 'OUT', 'HALT'].join('\n');
    assert.deepEqual(output(sum, [4, 5]), [9]);
  });

  it('runs off the end of the program as if it halted', () => {
    assert.deepEqual(output('PUSH 5\nOUT'), [5]);
  });

  it('stops at every boundary rather than misbehaving', () => {
    assert.match(failure('ADD\nHALT'), /stack underflow/);
    assert.match(failure('PUSH 1\nPUSH 0\nDIV\nHALT'), /division by zero/);
    assert.match(failure('PUSH 1\nPUSH 0\nMOD\nHALT'), /modulo by zero/);
    assert.match(failure('IN\nHALT', []), /no input left/);
    assert.match(failure('loop:\nJMP loop', [], tight), /step budget/);
    assert.match(
      failure('PUSH 9007199254740991\nPUSH 9007199254740991\nMUL\nHALT'),
      /overflow/,
    );
  });

  it('caps stack depth', () => {
    const source = ['loop:', 'PUSH 1', 'JMP loop'].join('\n');
    assert.match(failure(source, [], { ...DEFAULT_LIMITS, maxStack: 16 }), /stack overflow/);
  });

  it('caps program length', () => {
    const long = Array.from({ length: 40 }, () => 'PUSH 1').join('\n');
    assert.match(failure(long, [], { ...DEFAULT_LIMITS, maxInstructions: 20 }), /exceeds 20 instructions/);
  });

  it('is deterministic', () => {
    const source = 'IN\nDUP\nMUL\nOUT\nHALT';
    const a = execute(source, [12]);
    const b = execute(source, [12]);
    assert.deepEqual(a, b);
  });
});

describe('running a parsed program directly', () => {
  it('reports the step count', () => {
    const parsed = parse('PUSH 1\nPUSH 2\nADD\nOUT\nHALT');
    assert.ok(parsed.ok);
    const result = parsed.ok ? run(parsed.program, []) : undefined;
    assert.ok(result?.ok);
    assert.equal(result?.ok && result.steps, 5);
  });
});
