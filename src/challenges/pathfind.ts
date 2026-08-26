/**
 * PATHFIND - cheapest route through a weighted directed graph.
 *
 * Tier 0-3 is a plain shortest path. Tier 4+ forces the route through a
 * waypoint, and tier 7+ also closes a node. Routes are explicitly allowed to
 * revisit nodes, which makes "shortest via W" exactly `d(S,W) + d(W,E)` and
 * keeps the answer unambiguous.
 */

import type { ChallengeModule, GenerateContext, Rng, Task } from './deps.js';
import { byTier, buildTask, mark, withDecoys } from './util.js';

interface Edge {
  from: string;
  to: string;
  weight: number;
}

interface Secret {
  nodes: string[];
  edges: Edge[];
  start: string;
  end: string;
  waypoint?: string;
  banned?: string;
  answer: number;
}

const INF = Number.POSITIVE_INFINITY;

/** Dijkstra over an adjacency map. O(n^2) is plenty at this size. */
function shortest(nodes: string[], edges: Edge[], from: string, to: string, banned?: string): number {
  const live = nodes.filter((n) => n !== banned);
  const dist = new Map<string, number>(live.map((n) => [n, INF]));
  if (!dist.has(from) || !dist.has(to)) return INF;
  dist.set(from, 0);

  const settled = new Set<string>();
  const adjacency = new Map<string, Edge[]>();
  for (const e of edges) {
    if (e.from === banned || e.to === banned) continue;
    const list = adjacency.get(e.from);
    if (list) list.push(e);
    else adjacency.set(e.from, [e]);
  }

  while (settled.size < live.length) {
    let current: string | undefined;
    let best = INF;
    for (const n of live) {
      const d = dist.get(n)!;
      if (!settled.has(n) && d < best) {
        best = d;
        current = n;
      }
    }
    if (current === undefined) break;
    settled.add(current);
    for (const e of adjacency.get(current) ?? []) {
      const candidate = best + e.weight;
      if (candidate < dist.get(e.to)!) dist.set(e.to, candidate);
    }
  }

  return dist.get(to) ?? INF;
}

function callsigns(rng: Rng, count: number): string[] {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
  return rng.sample(letters, count).map((l) => `N${l}`);
}

export const pathfind: ChallengeModule = {
  family: 'pathfind',
  blurb: 'Cheapest route across a directed weighted network, with waypoints and closures.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards } = ctx;

    const nodeCount = byTier(tier, 6, 14);
    const nodes = callsigns(rng, nodeCount);
    const start = nodes[0]!;
    const end = nodes[nodeCount - 1]!;

    const edges: Edge[] = [];
    const seen = new Set<string>();
    const addEdge = (from: string, to: string, weight: number) => {
      if (from === to) return;
      const key = `${from}>${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from, to, weight });
    };

    // A spine through every node guarantees the graph is connected end to end,
    // so the answer is always finite.
    for (let i = 0; i < nodeCount - 1; i++) {
      addEdge(nodes[i]!, nodes[i + 1]!, rng.int(4, 25));
    }
    const extra = byTier(tier, 5, 26);
    for (let i = 0; i < extra; i++) {
      addEdge(rng.pick(nodes), rng.pick(nodes), rng.int(1, 30));
    }

    // A waypoint and a closure are only usable if they leave a finite route.
    let waypoint: string | undefined;
    let banned: string | undefined;
    const middle = nodes.slice(1, -1);

    if (tier >= 7 && middle.length > 2) {
      for (const candidate of rng.shuffle(middle)) {
        if (shortest(nodes, edges, start, end, candidate) < INF) {
          banned = candidate;
          break;
        }
      }
    }

    if (tier >= 4 && middle.length > 1) {
      for (const candidate of rng.shuffle(middle.filter((n) => n !== banned))) {
        const a = shortest(nodes, edges, start, candidate, banned);
        const b = shortest(nodes, edges, candidate, end, banned);
        if (a < INF && b < INF) {
          waypoint = candidate;
          break;
        }
      }
    }

    const answer = waypoint
      ? shortest(nodes, edges, start, waypoint, banned) + shortest(nodes, edges, waypoint, end, banned)
      : shortest(nodes, edges, start, end, banned);

    const listing = edges
      .slice()
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      .map((e) => `  ${e.from} -> ${e.to}  ${String(e.weight).padStart(3)}`)
      .join('\n');

    const constraints: string[] = [];
    if (banned) constraints.push(`Node ${banned} is CLOSED and may not be used.`);
    if (waypoint) constraints.push(`The route must pass through ${waypoint} at least once.`);

    const head = hazards.includes('terse')
      ? `DIRECTED, WEIGHTED. ${start} -> ${end}. Revisits allowed.`
      : [
          'A directed network. Each line is a one-way link and its cost.',
          'A route may revisit nodes and links; only total cost matters.',
        ].join('\n');

    const prompt = withDecoys(
      [
        head,
        '',
        listing,
        '',
        `START: ${start}`,
        `END:   ${end}`,
        ...(constraints.length ? ['', ...constraints] : []),
        '',
        'What is the lowest possible total cost?',
      ].join('\n'),
      rng,
      tier,
      hazards,
    );

    const secret: Secret = { nodes, edges, start, end, answer };
    if (waypoint) secret.waypoint = waypoint;
    if (banned) secret.banned = banned;

    return buildTask(ctx, 'pathfind', prompt, 'A single integer: the total cost.', secret);
  },

  verify(task: Task, raw: string) {
    const secret = task.secret as Secret;
    return mark(task, raw, String(secret.answer), 'int', task.hazards);
  },
};
