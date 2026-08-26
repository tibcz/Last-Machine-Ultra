/**
 * SPEC - follow a fussy pipeline over a small dataset and emit one exact string.
 *
 * This is the family that punishes skimming. The maths is trivial; the marking
 * is character-for-character, so a lowercase letter, a stray space around a
 * separator, or a forgotten tie-break rule is a DNF. It is here because that is
 * the failure mode that actually ends machine races - not arithmetic, but
 * instruction drift at hour 28 with a third of the token budget left.
 */

import type { ChallengeModule, GenerateContext, Rng, Task } from './deps.js';
import { byTier, buildTask, mark } from './util.js';

interface Row {
  id: string;
  name: string;
  score: number;
  region: string;
  withdrawn: boolean;
}

interface Stage {
  /** The rule text shown to the entrant. */
  rule: string;
  /** Terse form, used once the `terse` hazard lands. */
  terse: string;
}

interface Secret {
  records: Row[];
  stages: Stage[];
  answer: string;
}

const REGIONS = ['NORTH', 'SOUTH', 'EAST', 'WEST', 'CENTRAL'];

function makeRows(rng: Rng, count: number, withWithdrawn: boolean): Row[] {
  const used = new Set<string>();
  const rows: Row[] = [];
  while (rows.length < count) {
    const id = `R-${rng.int(10, 99)}`;
    if (used.has(id)) continue;
    used.add(id);
    const raw = rng.word(4, 7);
    rows.push({
      id,
      name: raw.charAt(0).toUpperCase() + raw.slice(1),
      score: rng.int(0, 99),
      region: rng.pick(REGIONS),
      withdrawn: withWithdrawn && rng.bool(0.22),
    });
  }
  return rows;
}

export const spec: ChallengeModule = {
  family: 'spec',
  blurb: 'Run a dataset through a stated pipeline and emit one exact string.',
  minTier: 0,

  generate(ctx: GenerateContext): Task {
    const { rng, tier, hazards } = ctx;
    const decoys = hazards.includes('decoys');

    const records = makeRows(rng, byTier(tier, 6, 14), decoys);
    const stages: Stage[] = [];

    // Every stage is chosen up front, then executed and rendered from the same
    // decision, so the rule text and the expected answer cannot drift apart.
    let working = records.filter((r) => !r.withdrawn);
    if (decoys) {
      stages.push({
        rule: 'Records marked WITHDRAWN are not part of the dataset. Discard them first.',
        terse: 'drop WITHDRAWN',
      });
    }

    // 1. Filter. Chosen from the data rather than at random: a filter that
    // empties the dataset would make the expected answer an empty string, and
    // an empty submission is never markable.
    const roomyRegions = REGIONS.filter(
      (region) => working.filter((r) => r.region === region).length >= 2,
    );
    if (tier >= 3 && roomyRegions.length > 0 && rng.bool(0.5)) {
      const region = rng.pick(roomyRegions);
      working = working.filter((r) => r.region === region);
      stages.push({ rule: `Keep only records in region ${region}.`, terse: `region==${region}` });
    } else {
      const scores = working.map((r) => r.score).sort((a, b) => a - b);
      const keepAtLeast = Math.min(3, scores.length);
      const threshold = scores[scores.length - keepAtLeast]!;
      working = working.filter((r) => r.score >= threshold);
      stages.push({ rule: `Keep only records with score >= ${threshold}.`, terse: `score>=${threshold}` });
    }

    // 2. Sort, with an explicit tie-break so the result is total.
    const sortDesc = rng.bool(0.6);
    const sortByName = tier >= 2 && rng.bool(0.4);
    if (sortByName) {
      working.sort((a, b) => (sortDesc ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
      stages.push({
        rule: `Sort by name ${sortDesc ? 'descending' : 'ascending'} (A-Z ordering).`,
        terse: `sort name ${sortDesc ? 'desc' : 'asc'}`,
      });
    } else {
      working.sort((a, b) => (sortDesc ? b.score - a.score : a.score - b.score) || a.id.localeCompare(b.id));
      stages.push({
        rule: `Sort by score ${sortDesc ? 'descending' : 'ascending'}; break ties by id ascending.`,
        terse: `sort score ${sortDesc ? 'desc' : 'asc'}, tie id asc`,
      });
    }

    // 3. Dedupe by region (tier 6+).
    if (tier >= 6) {
      const seen = new Set<string>();
      working = working.filter((r) => {
        if (seen.has(r.region)) return false;
        seen.add(r.region);
        return true;
      });
      stages.push({
        rule: 'Keep only the first record of each region, in the order produced above.',
        terse: 'dedupe by region (keep first)',
      });
    }

    // 4. Take.
    if (tier >= 1) {
      const take = rng.int(2, 5);
      working = working.slice(0, take);
      stages.push({ rule: `Keep at most the first ${take} records.`, terse: `take ${take}` });
    }

    // 5. Rotate (tier 8+).
    if (tier >= 8 && working.length > 1) {
      const by = rng.int(1, Math.max(1, working.length - 1));
      const k = by % working.length;
      working = [...working.slice(k), ...working.slice(0, k)];
      stages.push({ rule: `Rotate the list left by ${by} positions.`, terse: `rotl ${by}` });
    }

    // 6. Project.
    const projection = rng.pick(['id', 'name', 'id:score'] as const);
    let parts = working.map((r) => {
      if (projection === 'id') return r.id;
      if (projection === 'name') return r.name;
      return `${r.id}:${r.score}`;
    });
    stages.push({
      rule:
        projection === 'id:score'
          ? 'Render each record as its id, a colon, then its score.'
          : `Render each record as its ${projection}.`,
      terse: `project ${projection}`,
    });

    // 7. Case.
    if (tier >= 2) {
      const upper = rng.bool(0.5);
      parts = parts.map((p) => (upper ? p.toUpperCase() : p.toLowerCase()));
      stages.push({
        rule: `Convert every rendered value to ${upper ? 'UPPERCASE' : 'lowercase'}.`,
        terse: upper ? 'upper' : 'lower',
      });
    }

    // 8. Join.
    const separator = rng.pick(['-', '|', '/', '+'] as const);
    let answer = parts.join(separator);
    stages.push({
      rule: `Join the values with "${separator}" and no spaces.`,
      terse: `join "${separator}"`,
    });

    // 9. Wrap.
    if (tier >= 4) {
      const wrapWithCount = rng.bool(0.5);
      if (wrapWithCount) {
        answer = `[${parts.length}]${answer}`;
        stages.push({
          rule: 'Prefix the whole string with the number of joined values in square brackets.',
          terse: 'prefix [count]',
        });
      } else {
        const checksum = working.reduce((sum, r) => sum + r.score, 0);
        answer = `${answer}#${checksum}`;
        stages.push({
          rule: 'Append "#" and the sum of the scores of the surviving records.',
          terse: 'suffix #sum(score)',
        });
      }
    }

    const table = [
      'id     name        score  region     status',
      ...records.map(
        (r) =>
          `${r.id.padEnd(7)}${r.name.padEnd(12)}${String(r.score).padStart(3)}    ${r.region.padEnd(11)}${
            r.withdrawn ? 'WITHDRAWN' : 'ACTIVE'
          }`,
      ),
    ].join('\n');

    const ruleList = stages
      .map((s, i) => `  ${i + 1}. ${hazards.includes('terse') ? s.terse : s.rule}`)
      .join('\n');

    const prompt = hazards.includes('terse')
      ? `DATA\n${table}\n\nPIPE\n${ruleList}`
      : [
          'DATASET',
          table,
          '',
          'Apply these steps in order:',
          ruleList,
          '',
          'Output the resulting string and nothing else. It is compared character for character.',
        ].join('\n');

    const secret: Secret = { records, stages, answer };
    return buildTask(ctx, 'spec', prompt, 'One exact string. Case and punctuation matter.', secret);
  },

  verify(task: Task, raw: string) {
    const secret = task.secret as Secret;
    return mark(task, raw, secret.answer, 'exact', task.hazards);
  },
};
