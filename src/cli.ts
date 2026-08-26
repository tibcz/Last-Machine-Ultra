#!/usr/bin/env node
/**
 * The `lmu` command.
 *
 *   lmu simulate     run a whole race headlessly and print the report
 *   lmu serve        run a race with a live dashboard on http://localhost:8080
 *   lmu roster       validate and list the start list
 *   lmu yard         print one hour's brief, to develop your entrant against
 *   lmu verify       mark your own answers to a yard, offline
 *   lmu rules        print the ramp
 *   lmu bots         list the built-in simulated entrants
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { briefFor, generateYard, solutionFor, verifyTask } from './challenges/index.js';
import { BOTS } from './competitors/local.js';
import { renderBrief } from './competitors/prompting.js';
import { CompressedClock, InstantClock, WallClock, type RaceClock } from './core/clock.js';
import { DEFAULT_RAMP, describeRules, rulesForHour, type RampConfig } from './core/difficulty.js';
import { Race } from './core/race.js';
import { randomSeed } from './core/rng.js';
import { buildCompetitors, loadRoster } from './registry/roster.js';
import { banner, c, renderRamp, renderSummary, yardLine } from './report.js';
import { serveRace } from './server/server.js';

interface Args {
  command: string;
  flags: Map<string, string>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=', 2);
      if (inline !== undefined) {
        flags.set(name!, inline);
      } else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--')) {
        flags.set(name!, rest[++i]!);
      } else {
        flags.set(name!, 'true');
      }
    } else {
      positional.push(token);
    }
  }

  return { command, flags, positional };
}

const num = (args: Args, name: string, fallback: number): number => {
  const raw = args.flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got "${raw}"`);
  return value;
};

const flag = (args: Args, name: string): boolean => args.flags.get(name) === 'true';

function rampFrom(args: Args): RampConfig {
  const ramp = { ...DEFAULT_RAMP };
  if (args.flags.has('hour-ms')) ramp.hourMs = num(args, 'hour-ms', ramp.hourMs);
  if (args.flags.has('max-tasks')) ramp.maxTasks = num(args, 'max-tasks', ramp.maxTasks);
  return ramp;
}

function clockFrom(args: Args, ramp: RampConfig): RaceClock {
  const mode = args.flags.get('clock') ?? (args.command === 'serve' ? 'compressed' : 'instant');
  switch (mode) {
    case 'wall':
      return new WallClock();
    case 'compressed':
      return new CompressedClock(ramp.hourMs);
    case 'instant':
      return new InstantClock(ramp.hourMs);
    default:
      throw new Error(`--clock must be wall, compressed or instant (got "${mode}")`);
  }
}

async function rosterCompetitors(args: Args, seed: string) {
  const directory = resolve(args.flags.get('roster') ?? 'teams');
  const { teams, problems } = await loadRoster(directory);

  if (problems.length > 0) {
    console.error(c.red(`\n${problems.length} problem(s) in ${directory}:`));
    for (const problem of problems) console.error(`  ${c.bold(problem.file)}: ${problem.message}`);
    if (teams.length === 0) throw new Error('no valid teams on the start list');
    console.error(c.grey('\ncontinuing with the teams that validated\n'));
  }

  return { teams, competitors: buildCompetitors(teams, seed), directory };
}

// --------------------------------------------------------------------------

async function cmdSimulate(args: Args): Promise<void> {
  const seed = args.flags.get('seed') ?? randomSeed();
  const ramp = rampFrom(args);
  const { teams, competitors } = await rosterCompetitors(args, seed);

  console.log(banner());
  console.log('');
  console.log(
    c.grey(
      `seed ${c.bold(seed)}  |  ${competitors.length} entrant${
        competitors.length === 1 ? '' : 's'
      } from ${teams.length} team${teams.length === 1 ? '' : 's'}`,
    ),
  );
  console.log('');

  const race = new Race({
    seed,
    competitors,
    ramp,
    clock: clockFrom(args, ramp),
    maxHours: num(args, 'hours', 72),
  });

  const names = new Map(competitors.map((entrant) => [entrant.id, entrant.name]));
  race.on('yard:end', (report) => console.log(yardLine(report, names)));

  const summary = await race.run();
  await race.close();

  console.log(renderSummary(summary, race.reports));

  const out = args.flags.get('json');
  if (out) {
    await writeFile(
      resolve(out),
      JSON.stringify({ summary, yards: race.reports }, null, 2),
      'utf8',
    );
    console.log(c.grey(`\nwrote ${out}`));
  }
}

async function cmdServe(args: Args): Promise<void> {
  const seed = args.flags.get('seed') ?? randomSeed();
  const ramp = rampFrom(args);
  if (!args.flags.has('hour-ms') && (args.flags.get('clock') ?? 'compressed') === 'compressed') {
    // A watchable default: the whole night in a few minutes.
    ramp.hourMs = 6_000;
  }

  const { teams, competitors } = await rosterCompetitors(args, seed);
  const race = new Race({
    seed,
    competitors,
    ramp,
    clock: clockFrom(args, ramp),
    maxHours: num(args, 'hours', 72),
    waitForFirstBell: true,
  });

  const port = num(args, 'port', 8080);
  await serveRace(race, { port, teams });
}

async function cmdRoster(args: Args): Promise<void> {
  const directory = resolve(args.flags.get('roster') ?? 'teams');
  const { teams, problems } = await loadRoster(directory);

  console.log(banner());
  console.log('');
  console.log(c.bold(`START LIST  ${c.grey(directory)}`));
  console.log('');

  for (const team of teams) {
    console.log(
      `  ${c.bold(team.team)} ${c.grey(`(${team.slug})`)}${team.country ? c.grey(` ${team.country}`) : ''}`,
    );
    if (team.motto) console.log(`  ${c.grey(`"${team.motto}"`)}`);
    for (const entrant of team.entrants) {
      const detail =
        entrant.adapter === 'local'
          ? `local:${entrant.bot}`
          : entrant.adapter === 'http'
            ? `http ${entrant.endpoint}`
            : `${entrant.adapter} ${entrant.model ?? '(default model)'}`;
      console.log(`    ${c.cyan('-')} ${entrant.name} ${c.grey(detail)}`);
    }
    console.log('');
  }

  const entrantCount = teams.reduce((sum, t) => sum + t.entrants.length, 0);
  console.log(c.grey(`${teams.length} team(s), ${entrantCount} entrant(s)`));

  if (problems.length > 0) {
    console.log('');
    console.log(c.red(`${problems.length} problem(s):`));
    for (const problem of problems) console.log(`  ${c.bold(problem.file)}: ${problem.message}`);
    process.exitCode = 1;
  } else {
    console.log(c.green('all roster files valid'));
  }
}

async function cmdYard(args: Args): Promise<void> {
  const hour = num(args, 'hour', 1);
  const seed = args.flags.get('seed') ?? 'PREVIEW';
  const ramp = rampFrom(args);
  const yard = generateYard(seed, rulesForHour(hour, ramp));

  if (flag(args, 'json')) {
    console.log(JSON.stringify(briefFor(yard), null, 2));
    return;
  }

  console.log(c.grey(describeRules(yard.rules, ramp)));
  console.log('');
  console.log(renderBrief(briefFor(yard)));

  if (flag(args, 'solutions')) {
    console.log('');
    console.log(c.bold('SOLUTIONS'));
    for (const task of yard.tasks) {
      console.log('');
      console.log(c.cyan(`${task.id} [${task.family}]`));
      console.log(solutionFor(task) || c.grey('(no canonical form)'));
    }
  }
}

async function cmdVerify(args: Args): Promise<void> {
  const hour = num(args, 'hour', 1);
  const seed = args.flags.get('seed') ?? 'PREVIEW';
  const file = args.flags.get('answers');
  if (!file) throw new Error('--answers <file.json> is required');

  const { readFile } = await import('node:fs/promises');
  const answers = JSON.parse(await readFile(resolve(file), 'utf8')) as Record<string, string>;

  const yard = generateYard(seed, rulesForHour(hour, rampFrom(args)));
  let allOk = true;

  console.log(c.grey(`seed ${seed}, hour ${hour}`));
  console.log('');

  for (const task of yard.tasks) {
    const verdict = verifyTask(task, answers[task.id] ?? '');
    allOk &&= verdict.ok;
    const mark = verdict.ok ? c.green('PASS') : c.red('FAIL');
    console.log(`${mark}  ${task.id} ${c.grey(`[${task.family}]`)}`);
    if (!verdict.ok) {
      console.log(`      ${c.grey('wanted:')} ${verdict.expected}`);
      console.log(`      ${c.grey('got:   ')} ${verdict.got || c.grey('(nothing)')}`);
      if (verdict.note) console.log(`      ${c.grey('note:  ')} ${verdict.note}`);
    }
  }

  console.log('');
  console.log(allOk ? c.green('yard complete - you would still be in the race') : c.red('DNF'));
  if (!allOk) process.exitCode = 1;
}

function cmdRules(args: Args): void {
  console.log(banner());
  console.log('');
  console.log(renderRamp(num(args, 'hours', 36), rampFrom(args)));
}

function cmdBots(): void {
  console.log(c.bold('BUILT-IN SIMULATED ENTRANTS'));
  console.log(c.grey('for testing and for filling a corral. They do not solve anything.'));
  console.log('');
  for (const [name, profile] of Object.entries(BOTS)) {
    console.log(`  ${c.cyan(name.padEnd(12))} ${profile.blurb}`);
  }
}

function usage(): void {
  console.log(banner());
  console.log(`
${c.bold('USAGE')}
  lmu <command> [options]

${c.bold('COMMANDS')}
  simulate            run a full race headlessly and print the report
  serve               run a race with a live dashboard
  roster              validate and list the start list
  yard                print one hour's brief, to develop against
  verify              mark your own answers to a yard, offline
  rules               print the difficulty ramp
  bots                list the built-in simulated entrants

${c.bold('COMMON OPTIONS')}
  --seed <string>     the race seed. Same seed, same yards, every time.
  --roster <dir>      where the team files live (default: teams)
  --hours <n>         safety stop (default: 72)
  --hour-ms <ms>      how long an hour lasts (default: 3600000)
  --clock <mode>      wall | compressed | instant

${c.bold('EXAMPLES')}
  ${c.grey('# a whole race, instantly')}
  lmu simulate --seed OSLO2026

  ${c.grey('# watch one at ten seconds per hour')}
  lmu serve --hour-ms 10000

  ${c.grey('# see what hour 24 looks like before you write your entrant')}
  lmu yard --hour 24 --seed OSLO2026

  ${c.grey('# mark your own attempt')}
  lmu verify --hour 24 --seed OSLO2026 --answers my-answers.json
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'simulate':
    case 'race':
      await cmdSimulate(args);
      break;
    case 'serve':
      await cmdServe(args);
      break;
    case 'roster':
      await cmdRoster(args);
      break;
    case 'yard':
      await cmdYard(args);
      break;
    case 'verify':
      await cmdVerify(args);
      break;
    case 'rules':
      cmdRules(args);
      break;
    case 'bots':
      cmdBots();
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      console.error(c.red(`unknown command "${args.command}"`));
      usage();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(c.red(`\n${error instanceof Error ? error.message : String(error)}`));
  process.exitCode = 1;
});
