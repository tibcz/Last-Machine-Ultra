/**
 * Shared machinery for challenge families: how a prompt is framed, and how an
 * answer is marked.
 *
 * Marking is deliberately generous right up until the hazards say otherwise.
 * Early in a race we care whether the entrant got the answer, not whether it
 * said "The answer is" first. From hour 20 (`no_scratch`) we care about both,
 * and that shift is most of what makes hour 20 hurt.
 */

import type { Family, GenerateContext, Hazard, Rng, Task, VerifyResult } from './deps.js';

/** Drop markdown fences, zero-width junk, and smart quotes. */
export function stripFences(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

const LABEL = /^(?:final\s+)?(?:answer|result|output|solution|t\d+)\s*[:=-]\s*/i;

/** The line we actually mark, given the hazards in force. */
function candidateLine(raw: string, hazards: readonly Hazard[]): { line: string; violation?: string } {
  const cleaned = stripFences(raw);
  const lines = cleaned.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  if (lines.length === 0) return { line: '', violation: 'empty submission' };

  if (hazards.includes('no_scratch')) {
    // The whole submission must be the answer. One line, no label, no prose.
    if (lines.length > 1) {
      return { line: lines[lines.length - 1]!, violation: 'no_scratch: multi-line output' };
    }
    if (LABEL.test(lines[0]!)) {
      return { line: lines[0]!.replace(LABEL, ''), violation: 'no_scratch: labelled output' };
    }
    return { line: lines[0]! };
  }

  return { line: lines[lines.length - 1]!.replace(LABEL, '').trim() };
}

/**
 * How an answer is compared.
 *
 *   int    parse an integer out of the line
 *   text   case- and whitespace-insensitive
 *   list   ordered sequence, split on commas or whitespace
 *   exact  character-for-character, after trimming. Used by families whose
 *          whole point is producing an exact string.
 */
export type AnswerKind = 'int' | 'text' | 'list' | 'exact';

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[.,;!]+$/, '').trim();
}

function parseInt10(value: string): number | undefined {
  const match = value.replace(/[\s_,]/g, '').match(/-?\d+/);
  if (!match) return undefined;
  const n = Number(match[0]);
  return Number.isSafeInteger(n) ? n : undefined;
}

function splitList(value: string): string[] {
  return value
    .replace(/^[[(]/, '')
    .replace(/[\])]$/, '')
    .split(/[,\s>|]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Mark one answer. `expected` is the canonical form and is also what shows up
 * in the race report, so keep it presentable.
 */
export function mark(
  task: Task,
  raw: string,
  expected: string,
  kind: AnswerKind,
  hazards: readonly Hazard[],
): VerifyResult {
  const got = (raw ?? '').trim();
  const display = got.length > 120 ? `${got.slice(0, 117)}...` : got;
  const { line, violation } = candidateLine(got, hazards);

  if (violation) {
    return { ok: false, expected, got: display, note: violation };
  }

  let ok = false;
  switch (kind) {
    case 'int': {
      const want = parseInt10(expected);
      const have = parseInt10(line);
      ok = want !== undefined && have !== undefined && want === have;
      break;
    }
    case 'text':
      ok = normalizeText(line) === normalizeText(expected);
      break;
    case 'exact':
      ok = line === expected.trim();
      break;
    case 'list': {
      const want = splitList(expected).map(normalizeText);
      const have = splitList(line).map(normalizeText);
      ok = want.length === have.length && want.every((v, i) => v === have[i]);
      break;
    }
  }

  const result: VerifyResult = { ok, expected, got: display };
  if (!ok && line.length === 0) result.note = 'empty answer';
  void task;
  return result;
}

/**
 * Prompt framing. Under `terse` the explanatory half of a prompt is stripped -
 * the task is unchanged, but the entrant has to work out what is being asked.
 */
export function frame(hazards: readonly Hazard[], friendly: string, terse: string): string {
  return hazards.includes('terse') ? terse : friendly;
}

/** Answer-format line, withheld once `blind` lands. */
export function formatHint(hazards: readonly Hazard[], hint: string): string | undefined {
  return hazards.includes('blind') ? undefined : hint;
}

/**
 * A block of plausible, useless data. Under `decoys` every family that has no
 * natural distractor gets one of these stapled on.
 */
export function decoyBlock(rng: Rng, tier: number): string {
  const lines: string[] = [];
  const count = 2 + Math.floor(tier / 2);
  const labels = ['CALIBRATION', 'PRIOR RUN', 'ARCHIVE', 'TELEMETRY', 'SPARE', 'SCRATCH'];
  for (let i = 0; i < count; i++) {
    const label = rng.pick(labels);
    lines.push(`  ${label}-${rng.int(100, 999)}: ${rng.int(-9999, 9999)}`);
  }
  return `\nIgnored channel (not part of the task):\n${lines.join('\n')}`;
}

/** Applies `decoys` to a prompt if the hazard is in force. */
export function withDecoys(prompt: string, rng: Rng, tier: number, hazards: readonly Hazard[]): string {
  return hazards.includes('decoys') ? `${prompt}\n${decoyBlock(rng, tier)}` : prompt;
}

/** Scale helper: 0 at tier 0, 1 at tier 9. */
export function tierScale(tier: number): number {
  return Math.min(1, Math.max(0, tier / 9));
}

/** Linear interpolation across the tier range, rounded to an integer. */
export function byTier(tier: number, atZero: number, atNine: number): number {
  return Math.round(atZero + (atNine - atZero) * tierScale(tier));
}

/**
 * Assemble a task from the parts every family produces. Handles the `blind`
 * hazard (which withholds the answer format) in one place.
 */
export function buildTask(
  ctx: GenerateContext,
  family: Family,
  prompt: string,
  answerFormat: string,
  secret: unknown,
): Task {
  const task: Task = {
    id: ctx.id,
    family,
    tier: ctx.tier,
    prompt,
    hazards: [...ctx.hazards],
    secret,
  };
  const hint = formatHint(ctx.hazards, answerFormat);
  if (hint) task.answerFormat = hint;
  return task;
}
