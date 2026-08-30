/**
 * The live dashboard.
 *
 * A tiny HTTP server with no dependencies: one static page, one JSON endpoint,
 * and a server-sent-events stream. The race runs in the background and every
 * event pushes a fresh snapshot to whoever is watching. Snapshots are small
 * enough that sending the whole thing beats maintaining a diff protocol.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeRules, formatDuration, rulesForHour } from '../core/difficulty.js';
import type { Race } from '../core/race.js';
import type { TeamFile } from '../registry/roster.js';
import { c } from '../report.js';
import type { EntrantState, Hazard, RaceSummary, YardBrief } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface ServeOptions {
  port: number;
  teams: TeamFile[];
  /**
   * Interface to bind. Loopback by default: the dashboard has no auth, and
   * /api/teams serves the roster, so opening it to the network is a choice
   * the operator makes with --host rather than one they inherit.
   */
  host?: string;
}

interface FeedItem {
  hour: number;
  kind: 'bell' | 'out' | 'through' | 'end';
  text: string;
}

interface Snapshot {
  seed: string;
  status: RaceSummary['status'];
  clock: string;
  hour: number;
  hourMs: number;
  corral: number;
  starters: number;
  current: {
    hour: number;
    tier: number;
    taskCount: number;
    cutoff: string;
    tokenBudget: number;
    hazards: Hazard[];
    decider: boolean;
    families: string[];
  } | null;
  next: { hour: number; label: string } | null;
  entrants: EntrantState[];
  teams: RaceSummary['teams'];
  winner?: EntrantState;
  assist?: EntrantState;
  noWinner: boolean;
  feed: FeedItem[];
}

export async function serveRace(race: Race, options: ServeOptions): Promise<void> {
  const feed: FeedItem[] = [];
  const clients = new Set<ServerResponse>();
  let current: Snapshot['current'] = null;
  /** Size of the field at the start line. Fixed for the whole race, so the
   *  dashboard can read "8 of 10 standing" rather than "8 of 9". */
  let starters = 0;

  const names = new Map<string, string>();

  const snapshot = (): Snapshot => {
    const summary = race.summary;
    const nextHour = summary.status === 'finished' ? null : race.hour + 1;
    const shot: Snapshot = {
      seed: summary.seed,
      status: summary.status,
      clock: race.clock.label,
      hour: summary.hour,
      hourMs: race.clock.hourMs,
      corral: race.corral.length,
      starters,
      current,
      next:
        nextHour !== null
          ? { hour: nextHour, label: describeRules(rulesForHour(nextHour, race.ramp), race.ramp) }
          : null,
      entrants: summary.entrants,
      teams: summary.teams,
      noWinner: summary.noWinner,
      // Newest first, and capped: a 40-hour race with a big field produces more
      // feed than any dashboard needs to hold.
      feed: feed.slice(-120).reverse(),
    };
    if (summary.winner) shot.winner = summary.winner;
    if (summary.assist) shot.assist = summary.assist;
    return shot;
  };

  const broadcast = () => {
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const client of clients) client.write(payload);
  };

  const push = (item: FeedItem) => {
    feed.push(item);
    broadcast();
  };

  race.on('race:start', ({ entrants }) => {
    for (const entrant of entrants) names.set(entrant.id, entrant.name);
    starters = entrants.length;
    push({ hour: 0, kind: 'bell', text: `${entrants.length} machines in the corral. Seed ${race.seed}.` });
  });

  race.on('bell', ({ hour, brief, starters: field }) => {
    current = summarizeBrief(brief);
    push({
      hour,
      kind: 'bell',
      text: `Hour ${hour}: ${brief.taskCount} task${brief.taskCount === 1 ? '' : 's'} at tier ${
        brief.tier
      }, cutoff ${formatDuration(brief.cutoffMs)}. ${field.length} on the line.`,
    });
  });

  race.on('entrant:out', ({ entrant, reason, hour }) => {
    push({ hour, kind: 'out', text: `${entrant.name} (${entrant.team}) is out - ${reason.replace(/_/g, ' ')}.` });
  });

  race.on('yard:end', (report) => {
    push({
      hour: report.hour,
      kind: 'through',
      text: `${report.finishers.length} of ${report.starters} through hour ${report.hour}.`,
    });
  });

  race.on('race:end', (summary) => {
    current = null;
    push({
      hour: summary.hour,
      kind: 'end',
      text: summary.winner
        ? `${summary.winner.name} (${summary.winner.team}) wins after ${summary.winner.yards} yards.`
        : `No winner. The corral emptied at hour ${summary.hour}.`,
    });
  });

  const page = await readFile(join(here, 'public', 'index.html'), 'utf8');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot(), null, 2));
      return;
    }

    if (url.pathname === '/api/teams') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(options.teams, null, 2));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(options.port, host, resolve));

  const shown = host === '0.0.0.0' || host === '::' || host === '127.0.0.1' ? 'localhost' : host;
  const address = `http://${shown}:${options.port}`;
  console.log(`${c.bold('LAST MACHINE ULTRA')} ${c.grey('live')}`);
  console.log(`  ${c.cyan(address)}`);
  console.log(`  ${c.grey(`seed ${race.seed}, ${race.clock.label}`)}`);
  console.log(`  ${c.grey('ctrl-c to stop')}`);

  const shutdown = () => {
    for (const client of clients) client.end();
    server.close();
  };
  process.once('SIGINT', () => {
    shutdown();
    process.exit(0);
  });

  try {
    await race.run();
  } finally {
    await race.close();
  }

  // Keep serving after the finish so the final board can be read.
  console.log(c.grey('\nrace over - dashboard still up, ctrl-c to stop'));
}

function summarizeBrief(brief: YardBrief): Snapshot['current'] {
  return {
    hour: brief.hour,
    tier: brief.tier,
    taskCount: brief.taskCount,
    cutoff: formatDuration(brief.cutoffMs),
    tokenBudget: brief.tokenBudget,
    hazards: brief.hazards,
    decider: brief.decider,
    families: [...new Set(brief.tasks.map((t) => t.family))],
  };
}
