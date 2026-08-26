/**
 * KNIGHTS - knights always tell the truth, knaves always lie. Who is who?
 *
 * Statements are generated against a hidden assignment, then checked against
 * all 2^n possible assignments. A puzzle only ships if exactly one of them is
 * consistent - anything else is unfair in one of two directions. Two solutions
 * would eliminate an entrant for giving a legal answer; zero solutions (which
 * is what "I am a knave" produces) would eliminate everyone.
 *
 * Random claim sets make the better puzzle, so the generator tries those first
 * and falls back to a construction that is provably unique.
 */

import type { ChallengeModule, GenerateContext, Rng, Task } from './deps.js';
import { byTier, buildTask, mark } from './util.js';

type Claim =
  | { kind: 'is_knight'; who: number }
  | { kind: 'is_knave'; who: number }
  | { kind: 'both_knights'; a: number; b: number }
  | { kind: 'one_is_knave'; a: number; b: number }
  | { kind: 'same_type'; a: number; b: number }
  | { kind: 'headcount'; k: number }
  | { kind: 'implies_knave'; a: number; b: number };

interface Secret {
  names: string[];
  claims: Claim[];
  knights: string[];
}

/** Is the claim true under this assignment? (true = knight) */
function holds(claim: Claim, world: boolean[]): boolean {
  switch (claim.kind) {
    case 'is_knight':
      return world[claim.who]!;
    case 'is_knave':
      return !world[claim.who]!;
    case 'both_knights':
      return world[claim.a]! && world[claim.b]!;
    case 'one_is_knave':
      return !world[claim.a]! || !world[claim.b]!;
    case 'same_type':
      return world[claim.a]! === world[claim.b]!;
    case 'headcount':
      return world.filter(Boolean).length === claim.k;
    case 'implies_knave':
      return !world[claim.a]! || !world[claim.b]!;
  }
}

function render(claim: Claim, names: string[]): string {
  const n = (i: number) => names[i]!;
  switch (claim.kind) {
    case 'is_knight':
      return `${n(claim.who)} is a knight.`;
    case 'is_knave':
      return `${n(claim.who)} is a knave.`;
    case 'both_knights':
      return `${n(claim.a)} and ${n(claim.b)} are both knights.`;
    case 'one_is_knave':
      return `At least one of ${n(claim.a)} and ${n(claim.b)} is a knave.`;
    case 'same_type':
      return `${n(claim.a)} and I are the same type.`;
    case 'headcount':
      return `Exactly ${claim.k} of us ${claim.k === 1 ? 'is a knight' : 'are knights'}.`;
    case 'implies_knave':
      return `If ${n(claim.a)} is a knight, then ${n(claim.b)} is a knave.`;
  }
}

/** All assignments in which every speaker's claim matches their own type. */
function consistentWorlds(claims: Claim[], count: number): boolean[][] {
  const worlds: boolean[][] = [];
  for (let mask = 0; mask < 1 << count; mask++) {
    const world = Array.from({ length: count }, (_, i) => Boolean(mask & (1 << i)));
    if (claims.every((claim, i) => holds(claim, world) === world[i])) worlds.push(world);
  }
  return worlds;
}

/** A claim by `speaker` that is true iff `speaker` is a knight under `world`. */
function claimFor(rng: Rng, speaker: number, world: boolean[], tier: number): Claim {
  const count = world.length;
  const others = [...Array(count).keys()].filter((i) => i !== speaker);
  const wantTrue = world[speaker]!;

  const pool: Array<Claim['kind']> = ['is_knight', 'is_knave'];
  if (tier >= 2) pool.push('both_knights', 'one_is_knave');
  if (tier >= 4) pool.push('same_type');
  if (tier >= 6) pool.push('implies_knave', 'headcount');

  // Try a few shapes, keep the first that lands on the required truth value.
  for (let attempt = 0; attempt < 12; attempt++) {
    const kind = rng.pick(pool);
    const a = rng.pick(others);
    const b = rng.pick(others.filter((i) => i !== a).concat(others.length > 1 ? [] : [a]));
    let candidate: Claim;
    switch (kind) {
      case 'is_knight':
        candidate = { kind, who: a };
        break;
      case 'is_knave':
        candidate = { kind, who: a };
        break;
      case 'both_knights':
        candidate = { kind, a, b: b ?? a };
        break;
      case 'one_is_knave':
        candidate = { kind, a, b: b ?? a };
        break;
      case 'same_type':
        // The only self-reference that is safe: "X and I are the same type" is
        // informative whichever way it falls, unlike "I am a knave".
        candidate = { kind, a, b: speaker };
        break;
      case 'headcount':
        candidate = { kind, k: rng.int(0, count) };
        break;
      default:
        candidate = { kind: 'implies_knave', a, b: b ?? a };
    }
    if (holds(candidate, world) === wantTrue) return candidate;
  }

  // Fallback that always works: name someone and state their type correctly or
  // incorrectly, depending on what this speaker has to do.
  const target = others[0] ?? speaker;
  const targetIsKnight = world[target]!;
  const sayKnight = wantTrue ? targetIsKnight : !targetIsKnight;
  return sayKnight ? { kind: 'is_knight', who: target } : { kind: 'is_knave', who: target };
}

/**
 * A claim set with exactly one solution, by construction.
 *
 * Pick a pivot who is a knave. Everyone else states the pivot's type, which -
 * given the pivot's type - forces their own. That leaves exactly two candidate
 * worlds, and they are exact mirrors of each other.
 *
 * The pivot then breaks the mirror. Mirroring flips every islander's type, so
 * it also flips the truth of any claim OF THE FORM "X is a knight" - which is
 * why such claims can never distinguish a world from its mirror, and why a
 * headcount cannot either. `same_type` can: its truth is invariant under
 * mirroring while the speaker's obligation flips, so exactly one of the two
 * worlds survives it.
 *
 * The generator only reaches this when 60 random attempts came back ambiguous.
 */
function pinnedClaims(world: boolean[], count: number, rng: Rng): Claim[] {
  const knaves = [...Array(count).keys()].filter((i) => !world[i]);
  const knights = [...Array(count).keys()].filter((i) => world[i]);
  // The caller guarantees at least one of each, which is what makes this work.
  const pivot = rng.pick(knaves);
  const knight = rng.pick(knights);

  const claims: Claim[] = [];
  for (let i = 0; i < count; i++) {
    if (i === pivot) {
      // "<a knight> and I are the same type" - false, as a knave's claim must
      // be, and false in the mirror too, where it would have to be true.
      claims[i] = { kind: 'same_type', a: knight, b: pivot };
    } else {
      // The pivot is a knave, so "the pivot is a knave" is the true statement.
      claims[i] = world[i] ? { kind: 'is_knave', who: pivot } : { kind: 'is_knight', who: pivot };
    }
  }

  return claims;
}

export const knights: ChallengeModule = {
  family: 'knights',
  blurb: 'Knights tell the truth, knaves lie. Deduce the only consistent assignment.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards } = ctx;

    const count = byTier(tier, 3, 7);
    const names = rng
      .sample(
        ['ARDA', 'BRIX', 'CALO', 'DEVA', 'ELKO', 'FYRA', 'GARN', 'HOLT', 'IVRA', 'JOSK'],
        count,
      )
      .sort();

    // At least one of each: the answer is never "everyone" or "nobody", and the
    // fallback construction below needs both a knave to pivot on and a knight
    // to break the mirror with.
    let world: boolean[] = [];
    do {
      world = Array.from({ length: count }, () => rng.bool(0.5));
    } while (world.every(Boolean) || world.every((v) => !v));

    // Try random, varied claim sets first - they make the better puzzle - and
    // keep the first one that admits exactly one consistent world. Ambiguity
    // would fail entrants for giving a legal answer; a self-referential "I am a
    // knave" would admit no world at all and fail everyone.
    let claims: Claim[] | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      const candidate = world.map((_, i) => claimFor(rng, i, world, tier));
      if (consistentWorlds(candidate, count).length === 1) {
        claims = candidate;
        break;
      }
    }

    claims ??= pinnedClaims(world, count, rng);

    const solved = consistentWorlds(claims, count)[0]!;
    const knightNames = names.filter((_, i) => solved[i]).sort();

    const head = hazards.includes('terse')
      ? 'knights true, knaves false. who is a knight?'
      : [
          'On this island every inhabitant is either a knight, who only ever makes',
          'true statements, or a knave, who only ever makes false ones.',
        ].join('\n');

    const prompt = [
      head,
      '',
      ...claims.map((c, i) => `${names[i]!} says: "${render(c, names)}"`),
      '',
      'Which of them are knights?',
    ].join('\n');

    const secret: Secret = { names, claims, knights: knightNames };
    return buildTask(
      ctx,
      'knights',
      prompt,
      'The knights\' names, comma-separated, in alphabetical order. Write NONE if there are none.',
      secret,
    );
  },

  verify(task: Task, raw: string) {
    const secret = task.secret as Secret;
    const expected = secret.knights.length > 0 ? secret.knights.join(', ') : 'NONE';
    return mark(task, raw, expected, 'list', task.hazards);
  },
};

export const knightsInternals = { consistentWorlds, holds };
