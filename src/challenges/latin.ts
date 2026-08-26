/**
 * LATIN - complete a partially filled Latin square.
 *
 * Holes are punched one at a time and each removal is kept only if the square
 * still has exactly one completion, so every puzzle is solvable by deduction
 * alone. That matters: an ambiguous grid would fail entrants for guessing a
 * legal answer, and the format has no room for unfair yards.
 */

import type { ChallengeModule, GenerateContext, Rng, Task } from './deps.js';
import { byTier, buildTask, mark } from './util.js';

type Grid = number[][];

interface Secret {
  size: number;
  puzzle: (number | 0)[][];
  solution: Grid;
  /** Missing values in reading order - what the entrant actually submits. */
  answer: number[];
}

function cyclicSquare(n: number): Grid {
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => ((r + c) % n) + 1));
}

/** Shuffle rows, columns and symbol labels - all Latin-square-preserving. */
function randomSquare(rng: Rng, n: number): Grid {
  const base = cyclicSquare(n);
  const rowOrder = rng.shuffle([...Array(n).keys()]);
  const colOrder = rng.shuffle([...Array(n).keys()]);
  const symbols = rng.shuffle([...Array(n).keys()].map((i) => i + 1));

  return rowOrder.map((r) => colOrder.map((c) => symbols[base[r]![c]! - 1]!));
}

/** Count completions, stopping at `limit`. */
function countSolutions(grid: Grid, n: number, limit = 2): number {
  let found = 0;

  const search = (): boolean => {
    let row = -1;
    let col = -1;
    for (let r = 0; r < n && row < 0; r++) {
      for (let c = 0; c < n; c++) {
        if (grid[r]![c] === 0) {
          row = r;
          col = c;
          break;
        }
      }
    }
    if (row < 0) {
      found++;
      return found >= limit;
    }
    for (let value = 1; value <= n; value++) {
      let legal = true;
      for (let i = 0; i < n; i++) {
        if (grid[row]![i] === value || grid[i]![col] === value) {
          legal = false;
          break;
        }
      }
      if (!legal) continue;
      grid[row]![col] = value;
      const stop = search();
      grid[row]![col] = 0;
      if (stop) return true;
    }
    return false;
  };

  search();
  return found;
}

export const latin: ChallengeModule = {
  family: 'latin',
  blurb: 'Fill a Latin square with exactly one legal completion.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards } = ctx;

    const size = byTier(tier, 4, 7);
    const solution = randomSquare(rng, size);
    const puzzle: Grid = solution.map((row) => row.slice());

    const targetHoles = Math.min(size * size - size, byTier(tier, 4, 16));
    const cells = rng.shuffle(
      Array.from({ length: size * size }, (_, i) => [Math.floor(i / size), i % size] as const),
    );

    let holes = 0;
    for (const [r, c] of cells) {
      if (holes >= targetHoles) break;
      const saved = puzzle[r]![c]!;
      puzzle[r]![c] = 0;
      if (countSolutions(puzzle, size) === 1) {
        holes++;
      } else {
        puzzle[r]![c] = saved;
      }
    }

    const answer: number[] = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (puzzle[r]![c] === 0) answer.push(solution[r]![c]!);
      }
    }

    const rendered = puzzle
      .map((row) => row.map((v) => (v === 0 ? '.' : String(v))).join(' '))
      .join('\n');

    const head = hazards.includes('terse')
      ? `LATIN ${size}x${size}. symbols 1-${size}. fill '.'`
      : [
          `A ${size} by ${size} grid. Every row and every column must contain each of`,
          `the symbols 1 to ${size} exactly once. Dots are missing values.`,
        ].join('\n');

    const prompt = [
      head,
      '',
      rendered,
      '',
      `Give the ${answer.length} missing values, reading left to right, top to bottom.`,
    ].join('\n');

    const secret: Secret = { size, puzzle, solution, answer };
    return buildTask(
      ctx,
      'latin',
      prompt,
      `${answer.length} integers, comma-separated, in reading order.`,
      secret,
    );
  },

  verify(task: Task, raw: string) {
    const secret = task.secret as Secret;
    return mark(task, raw, secret.answer.join(', '), 'list', task.hazards);
  },
};

export const latinInternals = { randomSquare, countSolutions, cyclicSquare };
