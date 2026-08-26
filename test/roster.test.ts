import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

import { buildCompetitors, loadRoster, validateTeam } from '../src/registry/roster.js';

const ok = {
  team: 'Vasfej Kollektiva',
  slug: 'vasfej-kollektiva',
  contact: 'vasfej@example.com',
  entrants: [{ name: 'Vasfej I', adapter: 'local', bot: 'grinder' }],
};

const check = (patch: Record<string, unknown>, file = 'vasfej-kollektiva.json') =>
  validateTeam({ ...ok, ...patch }, file);

describe('roster validation', () => {
  it('accepts a well-formed file', () => {
    const { team, errors } = check({});
    assert.deepEqual(errors, []);
    assert.equal(team?.slug, 'vasfej-kollektiva');
    assert.equal(team?.entrants.length, 1);
  });

  it('requires the slug to match the filename', () => {
    const { errors } = check({ slug: 'something-else' });
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /file is named/);
  });

  it('requires a kebab-case slug', () => {
    assert.match(check({ slug: 'Vasfej Kollektiva' }).errors.join(), /kebab-case/);
  });

  it('requires team, contact and entrants', () => {
    assert.match(validateTeam({ ...ok, team: undefined }, 'x.json').errors.join(), /"team" is required/);
    assert.match(validateTeam({ ...ok, contact: '' }, 'x.json').errors.join(), /"contact" is required/);
    assert.match(check({ entrants: [] }).errors.join(), /non-empty array/);
  });

  it('caps a team at three machines', () => {
    const four = Array.from({ length: 4 }, (_, i) => ({
      name: `M${i}`,
      adapter: 'local',
      bot: 'pacer',
    }));
    assert.match(check({ entrants: four }).errors.join(), /at most 3/);
  });

  it('rejects duplicate entrant names within a team', () => {
    const errors = check({
      entrants: [
        { name: 'Twin', adapter: 'local', bot: 'pacer' },
        { name: 'twin', adapter: 'local', bot: 'spark' },
      ],
    }).errors;
    assert.match(errors.join(), /used twice/);
  });

  it('rejects unknown adapters and unknown bots', () => {
    assert.match(
      check({ entrants: [{ name: 'X', adapter: 'telepathy' }] }).errors.join(),
      /adapter must be one of/,
    );
    assert.match(
      check({ entrants: [{ name: 'X', adapter: 'local', bot: 'greased-lightning' }] }).errors.join(),
      /is unknown/,
    );
  });

  it('requires the fields each adapter actually needs', () => {
    assert.match(
      check({ entrants: [{ name: 'X', adapter: 'http' }] }).errors.join(),
      /endpoint is required/,
    );
    assert.match(
      check({ entrants: [{ name: 'X', adapter: 'http', endpoint: 'ftp://nope' }] }).errors.join(),
      /http\(s\) URL/,
    );
    assert.match(
      check({ entrants: [{ name: 'X', adapter: 'openai' }] }).errors.join(),
      /model is required/,
    );
    // Anthropic has a sensible default model, so it needs nothing else.
    assert.deepEqual(check({ entrants: [{ name: 'X', adapter: 'anthropic' }] }).errors, []);
  });
});

/**
 * Roster files are public. Catching a pasted credential in review is the whole
 * reason this check exists, so it is tested harder than the rest.
 */
describe('roster files must not carry credentials', () => {
  it('rejects values shaped like API keys', () => {
    const shapes = [
      'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA',
      'sk-proj-BBBBBBBBBBBBBBBBBBBB',
      'ghp_CCCCCCCCCCCCCCCCCCCCCCCCC',
      'AIzaDDDDDDDDDDDDDDDDDDDDDDDDD',
      'xoxb-1234567890-abcdefghij',
      'Bearer EEEEEEEEEEEEEEEEEEEEEE',
    ];
    for (const value of shapes) {
      const errors = check({
        entrants: [{ name: 'X', adapter: 'http', endpoint: 'https://x.example', tokenEnv: value }],
      }).errors;
      assert.ok(
        errors.some((e) => /looks like/.test(e)),
        `did not flag ${value}`,
      );
    }
  });

  it('rejects raw secret-shaped fields even when the value looks harmless', () => {
    for (const key of ['apiKey', 'token', 'secret', 'password', 'key']) {
      const errors = check({
        entrants: [{ name: 'X', adapter: 'local', bot: 'pacer', [key]: 'hunter2' }],
      }).errors;
      assert.ok(
        errors.some((e) => e.includes(key)),
        `did not flag a raw "${key}" field`,
      );
    }
  });

  it('is happy with env var names, which is the supported way', () => {
    assert.deepEqual(
      check({
        entrants: [
          {
            name: 'X',
            adapter: 'http',
            endpoint: 'https://x.example',
            tokenEnv: 'MY_TEAM_TOKEN',
          },
        ],
      }).errors,
      [],
    );
  });
});

describe('the shipped roster', () => {
  it('loads with no problems', async () => {
    const { teams, problems } = await loadRoster(resolve('teams'));
    assert.deepEqual(problems, [], 'the repository\'s own roster must always validate');
    assert.ok(teams.length >= 2, 'need at least two teams for a race to mean anything');
  });

  it('builds one competitor per entrant, with unique ids', async () => {
    const { teams } = await loadRoster(resolve('teams'));
    const competitors = buildCompetitors(teams, 'SEED');
    const expected = teams.reduce((sum, t) => sum + t.entrants.length, 0);

    assert.equal(competitors.length, expected);
    assert.equal(new Set(competitors.map((c) => c.id)).size, expected);
    for (const competitor of competitors) {
      assert.ok(competitor.name.length > 0);
      assert.ok(competitor.teamSlug.length > 0);
    }
  });

  it('reports a missing directory instead of throwing', async () => {
    const { teams, problems } = await loadRoster(resolve('no-such-directory'));
    assert.deepEqual(teams, []);
    assert.match(problems[0]?.message ?? '', /not found/);
  });
});
