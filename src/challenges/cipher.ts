/**
 * CIPHER - peel a stack of classical ciphers back off a message.
 *
 * Every layer on its own is a schoolbook exercise. The difficulty is entirely
 * in the stacking: the layers are listed in the order they were APPLIED, so
 * they have to come off backwards, and one slip early ruins everything after
 * it. From tier 6 one key is withheld and replaced with a crib, which turns a
 * mechanical job into a short search.
 */

import type { ChallengeModule, GenerateContext, Rng, Task } from './deps.js';
import { byTier, buildTask, mark } from './util.js';

const A = 'A'.charCodeAt(0);

type Layer =
  | { kind: 'caesar'; shift: number; hidden?: boolean }
  | { kind: 'atbash' }
  | { kind: 'vigenere'; key: string }
  | { kind: 'railfence'; rails: number }
  | { kind: 'reverse' };

interface Secret {
  plaintext: string;
  ciphertext: string;
  layers: Layer[];
}

function caesar(text: string, shift: number): string {
  return text.replace(/[A-Z]/g, (ch) =>
    String.fromCharCode(((ch.charCodeAt(0) - A + shift + 26) % 26) + A),
  );
}

function atbash(text: string): string {
  return text.replace(/[A-Z]/g, (ch) => String.fromCharCode(25 - (ch.charCodeAt(0) - A) + A));
}

function vigenere(text: string, key: string, decode: boolean): string {
  let k = 0;
  return text.replace(/[A-Z]/g, (ch) => {
    const shift = key.charCodeAt(k % key.length) - A;
    k++;
    const delta = decode ? -shift : shift;
    return String.fromCharCode(((ch.charCodeAt(0) - A + delta + 26) % 26) + A);
  });
}

function railPattern(length: number, rails: number): number[] {
  const pattern: number[] = [];
  let row = 0;
  let dir = 1;
  for (let i = 0; i < length; i++) {
    pattern.push(row);
    if (row === 0) dir = 1;
    else if (row === rails - 1) dir = -1;
    row += dir;
  }
  return pattern;
}

function railEncode(text: string, rails: number): string {
  if (rails < 2 || text.length <= rails) return text;
  const pattern = railPattern(text.length, rails);
  const rows: string[] = Array.from({ length: rails }, () => '');
  for (let i = 0; i < text.length; i++) rows[pattern[i]!] += text[i]!;
  return rows.join('');
}

function railDecode(text: string, rails: number): string {
  if (rails < 2 || text.length <= rails) return text;
  const pattern = railPattern(text.length, rails);
  const cursor: number[] = [];
  let acc = 0;
  for (let r = 0; r < rails; r++) {
    cursor.push(acc);
    acc += pattern.filter((p) => p === r).length;
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const r = pattern[i]!;
    out += text[cursor[r]!]!;
    cursor[r] = cursor[r]! + 1;
  }
  return out;
}

function applyLayer(text: string, layer: Layer): string {
  switch (layer.kind) {
    case 'caesar':
      return caesar(text, layer.shift);
    case 'atbash':
      return atbash(text);
    case 'vigenere':
      return vigenere(text, layer.key, false);
    case 'railfence':
      return railEncode(text, layer.rails);
    case 'reverse':
      return text.split('').reverse().join('');
  }
}

function describeLayer(layer: Layer): string {
  switch (layer.kind) {
    case 'caesar':
      return layer.hidden ? 'CAESAR shift=?' : `CAESAR shift=${layer.shift}`;
    case 'atbash':
      return 'ATBASH';
    case 'vigenere':
      return `VIGENERE key=${layer.key}`;
    case 'railfence':
      return `RAILFENCE rails=${layer.rails}`;
    case 'reverse':
      return 'REVERSE';
  }
}

function makeLayer(rng: Rng, tier: number): Layer {
  const pool: Array<Layer['kind']> = ['caesar', 'atbash', 'reverse'];
  if (tier >= 2) pool.push('vigenere');
  if (tier >= 4) pool.push('railfence');
  const kind = rng.pick(pool);
  switch (kind) {
    case 'caesar':
      return { kind, shift: rng.int(1, 25) };
    case 'vigenere':
      return { kind, key: rng.word(3, byTier(tier, 3, 7)).toUpperCase() };
    case 'railfence':
      return { kind, rails: rng.int(2, byTier(tier, 3, 6)) };
    default:
      return { kind: kind as 'atbash' | 'reverse' };
  }
}

export const cipher: ChallengeModule = {
  family: 'cipher',
  blurb: 'Undo a stack of classical ciphers, in reverse order, exactly.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards } = ctx;

    const wordCount = byTier(tier, 3, 6);
    const plaintext = Array.from({ length: wordCount }, () => rng.word(4, 8))
      .join('')
      .toUpperCase();

    const layerCount = byTier(tier, 1, 5);
    const layers: Layer[] = [];
    for (let i = 0; i < layerCount; i++) layers.push(makeLayer(rng, tier));

    // From tier 6 one Caesar shift is withheld. A crib makes it uniquely
    // recoverable - 26 candidates, one of which produces the crib.
    if (tier >= 6) {
      const caesarIndexes = layers
        .map((l, i) => (l.kind === 'caesar' ? i : -1))
        .filter((i) => i >= 0);
      if (caesarIndexes.length === 0) {
        layers[rng.int(0, layers.length - 1)] = { kind: 'caesar', shift: rng.int(1, 25), hidden: true };
      } else {
        const target = layers[rng.pick(caesarIndexes)] as Extract<Layer, { kind: 'caesar' }>;
        target.hidden = true;
      }
    }

    let ciphertext = plaintext;
    for (const layer of layers) ciphertext = applyLayer(ciphertext, layer);

    const cribLength = Math.min(6, plaintext.length);
    const hasHidden = layers.some((l) => l.kind === 'caesar' && l.hidden);

    const lines = [
      'A message was encrypted by applying these layers, in this order:',
      '',
      ...layers.map((l, i) => `  ${i + 1}. ${describeLayer(l)}`),
      '',
      `CIPHERTEXT: ${ciphertext}`,
    ];
    if (hasHidden) {
      lines.push('', `CRIB: the plaintext begins with ${plaintext.slice(0, cribLength)}`);
    }
    lines.push('', 'Recover the plaintext.');

    if (hazards.includes('terse')) {
      lines.splice(0, 1, 'Applied in order:');
      lines.splice(lines.length - 2, 2);
    }

    const secret: Secret = { plaintext, ciphertext, layers };
    return buildTask(
      ctx,
      'cipher',
      lines.join('\n'),
      'The plaintext, uppercase A-Z, no spaces.',
      secret,
    );
  },

  verify(task: Task, raw: string) {
    const secret = task.secret as Secret;
    return mark(task, raw, secret.plaintext, 'text', task.hazards);
  },
};

/** Exposed for the test suite: decoding must invert encoding exactly. */
export const cipherInternals = {
  applyLayer,
  railEncode,
  railDecode,
  caesar,
  atbash,
  vigenere,
};
