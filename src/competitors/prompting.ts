/**
 * Turning a yard into a prompt, and a reply back into answers.
 *
 * Shared by every adapter that talks to a language model, and documented for
 * teams writing their own runner: an HTTP entrant gets the brief as JSON and
 * can ignore all of this, but if you are wrapping a model, this is the
 * protocol that has been tested against the marker.
 */

import { HAZARD_BLURB, type PublicTask, type YardBrief } from '../core/types.js';

/**
 * Answers come back wrapped in tags rather than on labelled lines, because
 * ULTRASM answers are whole programs and would destroy any line-based format.
 */
const ANSWER_TAG = /<answer\s+id\s*=\s*["']?([A-Za-z0-9_]+)["']?\s*>([\s\S]*?)<\/answer>/g;

export function renderBrief(brief: YardBrief): string {
  const lines: string[] = [
    `LAST MACHINE ULTRA - HOUR ${brief.hour}`,
    '',
    `Tasks in this yard: ${brief.taskCount}`,
    `Difficulty tier:    ${brief.tier} of 9`,
    `Cutoff:             ${Math.round(brief.cutoffMs / 1000)}s from now`,
    `Token budget:       ${brief.tokenBudget}`,
  ];

  if (brief.decider) {
    lines.push('', 'This yard can end the race. Two of you are left.');
  }

  if (brief.hazards.length > 0) {
    lines.push('', 'HAZARDS IN FORCE');
    for (const hazard of brief.hazards) {
      lines.push(`  ${hazard.toUpperCase()}: ${HAZARD_BLURB[hazard]}`);
    }
  }

  lines.push(
    '',
    'You must answer every task correctly and be back before the cutoff.',
    'One wrong answer ends your race. There is no partial credit.',
    '',
    'Reply with one block per task, and nothing outside the blocks:',
    '',
    '  <answer id="TASK_ID">',
    '  your answer',
    '  </answer>',
    '',
    'The text inside each block is marked exactly as written.',
    '',
    '='.repeat(60),
  );

  for (const task of brief.tasks) {
    lines.push('', renderTask(task), '', '='.repeat(60));
  }

  return lines.join('\n');
}

export function renderTask(task: PublicTask): string {
  const lines = [`TASK ${task.id}  [${task.family}, tier ${task.tier}]`, '', task.prompt];
  if (task.answerFormat) lines.push('', `Answer format: ${task.answerFormat}`);
  return lines.join('\n');
}

/**
 * Pull answers out of a model reply.
 *
 * Deliberately forgiving about everything except which answer belongs to which
 * task. A model that returns a bare answer to a single-task yard is understood;
 * a model that mislabels its blocks is not, because guessing there would mark
 * the wrong thing correct.
 */
export function parseAnswers(reply: string, taskIds: readonly string[]): Record<string, string> {
  const answers: Record<string, string> = {};

  for (const match of reply.matchAll(ANSWER_TAG)) {
    const id = match[1]!;
    if (taskIds.includes(id)) answers[id] = (match[2] ?? '').trim();
  }

  if (Object.keys(answers).length === 0 && taskIds.length === 1) {
    // A single-task yard with no tags at all: take the whole reply.
    answers[taskIds[0]!] = reply.trim();
  }

  for (const id of taskIds) {
    if (!(id in answers)) answers[id] = '';
  }

  return answers;
}

export const SYSTEM_PROMPT = [
  'You are an entrant in Last Machine Ultra, a last-one-standing race.',
  'Every hour you get a yard of tasks that is harder than the last one.',
  'Answer all of them correctly, before the cutoff, or your race is over.',
  'Follow the stated answer format exactly. Wrap each answer in its <answer> block.',
].join(' ');
