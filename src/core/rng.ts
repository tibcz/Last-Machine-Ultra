/**
 * Deterministic pseudo-randomness.
 *
 * Every yard in a race is generated from `(raceSeed, hour, taskIndex)`. That
 * gives the format two properties it depends on:
 *
 *  - every entrant in a yard gets byte-identical tasks, and
 *  - a whole race can be replayed from its seed alone.
 *
 * Nothing here is cryptographically secure and nothing needs to be.
 */

/** xmur3 - turns an arbitrary string into a 32-bit seed. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** Stable 32-bit hash of any list of seed parts. */
export function hashSeed(...parts: Array<string | number>): number {
  return xmur3(parts.join(' '))();
}

/** A short, human-typeable seed string. */
export function randomSeed(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export class Rng {
  #state: number;

  constructor(seed: string | number) {
    this.#state = (typeof seed === 'number' ? seed >>> 0 : hashSeed(seed)) || 0x9e3779b9;
  }

  /** mulberry32 - float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive on both ends. */
  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  /** `count` distinct members of `items`, in a random order. */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.min(count, items.length));
  }

  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  /** Pick by weight. Weights need not sum to 1. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
    if (total <= 0) throw new Error('Rng.weighted: all weights are zero');
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= Math.max(0, weight);
      if (roll <= 0) return value;
    }
    return entries[entries.length - 1]![0];
  }

  /** A pronounceable nonsense word - handy for cipher plaintexts and callsigns. */
  word(minLen = 4, maxLen = 8): string {
    const consonants = 'bcdfghjklmnpqrstvwxz'.split('');
    const vowels = 'aeiou'.split('');
    const len = this.int(minLen, maxLen);
    let out = '';
    while (out.length < len) {
      out += this.pick(consonants);
      if (out.length < len) out += this.pick(vowels);
    }
    return out.slice(0, len);
  }
}

/** The canonical way to derive a per-task generator from a race. */
export function taskRng(raceSeed: string, hour: number, index: number, salt = ''): Rng {
  return new Rng(hashSeed(raceSeed, 'hour', hour, 'task', index, salt));
}
