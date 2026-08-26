/**
 * Terminal output.
 *
 * A race is a story about attrition, so the report is built around when people
 * went out and why, not around a scoreboard.
 */

import { formatDuration, rulesForHour, type RampConfig } from './core/difficulty.js';
import type { YardReport } from './core/race.js';
import type { EntrantState, OutReason, RaceSummary } from './core/types.js';

const useColor = process.stdout.isTTY === true && !process.env['NO_COLOR'];

const ESC = '\u001b[';
const paint = (code: string) => (text: string) =>
  useColor ? `${ESC}${code}m${text}${ESC}0m` : text;

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
  grey: paint('90'),
};

const OUT_REASON: Record<OutReason, string> = {
  missed_cutoff: 'missed the cutoff',
  wrong_answer: 'wrong answer',
  no_submission: 'no submission',
  error: 'error',
  withdrew: 'withdrew',
};

export function describeOutReason(reason: OutReason | undefined): string {
  return reason ? OUT_REASON[reason] : '';
}

export function banner(): string {
  return [
    c.bold('LAST MACHINE ULTRA'),
    c.grey('every hour, on the hour, the yard gets harder'),
  ].join('\n');
}

function pad(text: string, width: number): string {
  // Padding has to be measured on the visible text, not the escape codes.
  const visible = text.replace(/\u001b\[[0-9;]*m/g, '');
  return text + ' '.repeat(Math.max(0, width - visible.length));
}

/** The live-ish line printed as each yard closes. */
export function yardLine(report: YardReport, names: Map<string, string>): string {
  const head = c.bold(`HOUR ${String(report.hour).padStart(2, '0')}`);
  const kept = `${report.finishers.length}/${report.starters}`;
  const tag = report.decider ? c.yellow(' [DECIDER]') : '';

  const lost =
    report.eliminated.length > 0
      ? c.red(`  out: ${report.eliminated.map((id) => names.get(id) ?? id).join(', ')}`)
      : '';

  return `${head}${tag}  tier ${report.rules.tier}  ${report.rules.taskCount} task${
    report.rules.taskCount === 1 ? '' : 's'
  }  cutoff ${formatDuration(report.rules.cutoffMs)}  ${c.grey(`through ${kept}`)}${lost}`;
}

function entrantRow(entrant: EntrantState, widest: number): string {
  const status =
    entrant.status === 'winner'
      ? c.green('WINNER')
      : entrant.assist
        ? c.yellow('assist')
        : entrant.status === 'in_corral'
          ? c.cyan('standing')
          : c.grey('DNF');

  const why =
    entrant.status === 'winner'
      ? ''
      : c.grey(
          `  out at hour ${entrant.outAtHour ?? '-'}, ${describeOutReason(entrant.outReason)}${
            entrant.lastNote ? ` (${entrant.lastNote})` : ''
          }`,
        );

  return [
    c.grey(String(entrant.bib).padStart(3)),
    ' ',
    pad(entrant.name, widest + 2),
    pad(c.grey(entrant.team), 26),
    pad(String(entrant.yards), 6),
    pad(status, 18),
    why,
  ].join('');
}

export function renderSummary(summary: RaceSummary, reports: readonly YardReport[]): string {
  const lines: string[] = [];
  const widest = Math.max(4, ...summary.entrants.map((e) => e.name.length));

  lines.push('');
  lines.push(c.bold('RESULT'));
  lines.push(c.grey(`seed ${summary.seed}  |  ${reports.length} yards run`));
  lines.push('');

  if (summary.winner) {
    lines.push(
      `  ${c.green('WINNER')}  ${c.bold(summary.winner.name)} ${c.grey(`(${summary.winner.team})`)} - ${
        summary.winner.yards
      } yards`,
    );
    if (summary.assist) {
      lines.push(
        `  ${c.yellow('ASSIST')}  ${summary.assist.name} ${c.grey(
          `(${summary.assist.team})`,
        )} - ${summary.assist.yards} yards`,
      );
    }
  } else if (summary.noWinner) {
    lines.push(`  ${c.red('NO WINNER')} - the last of the corral went out together at hour ${summary.hour}.`);
    if (summary.assist) {
      lines.push(`  ${c.grey(`furthest: ${summary.assist.name} (${summary.assist.team}), ${summary.assist.yards} yards`)}`);
    }
  } else {
    lines.push(`  ${c.grey('race stopped without a decision')}`);
  }

  lines.push('');
  lines.push(
    c.grey(
      [
        '   #',
        ' ',
        pad('entrant', widest + 2),
        pad('team', 26),
        pad('yards', 6),
        'status',
      ].join(''),
    ),
  );
  for (const entrant of summary.entrants) lines.push(entrantRow(entrant, widest));

  lines.push('');
  lines.push(c.bold('TEAMS'));
  for (const team of summary.teams) {
    const mark = team.won ? c.green(' *') : '  ';
    lines.push(
      `${mark} ${pad(team.team, 30)} ${c.grey(`best ${team.bestYards} yards, ${team.entrants} entrant${team.entrants === 1 ? '' : 's'}`)}`,
    );
  }

  return lines.join('\n');
}

/** The ramp table: what the night looks like before anyone runs it. */
export function renderRamp(hours: number, ramp: RampConfig): string {
  const lines: string[] = [];
  lines.push(c.bold('THE RAMP'));
  lines.push(
    c.grey(
      `${pad('hour', 6)}${pad('tier', 6)}${pad('tasks', 7)}${pad('cutoff', 15)}${pad('tokens', 9)}${pad('unlocks', 21)}hazards`,
    ),
  );

  let previousFamilies: string[] = [];
  for (let hour = 1; hour <= hours; hour++) {
    const rules = rulesForHour(hour, ramp);
    const unlocked = rules.families.filter((f) => !previousFamilies.includes(f));
    previousFamilies = [...rules.families];

    const share = Math.round((rules.cutoffMs / ramp.hourMs) * 100);
    lines.push(
      [
        pad(String(hour), 6),
        pad(String(rules.tier), 6),
        pad(String(rules.taskCount), 7),
        pad(`${formatDuration(rules.cutoffMs)} (${share}%)`, 15),
        pad(String(rules.tokenBudget), 9),
        pad(unlocked.length > 0 ? c.cyan(unlocked.join(' ')) : '', 21),
        rules.hazards.length > 0 ? c.magenta(rules.hazards.join(' ')) : c.grey('-'),
      ].join(''),
    );
  }

  return lines.join('\n');
}
