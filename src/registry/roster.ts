/**
 * The start list.
 *
 * A group signs up by adding one JSON file to `teams/`. That is the whole
 * process: no database, no server, no account. The file is reviewed like any
 * other change, and CI runs the same validation this module exposes, so a
 * malformed roster fails before race day rather than at the bell.
 *
 * Roster files never contain credentials. They name environment variables, and
 * validation actively rejects anything that looks like a key pasted in by
 * mistake - a footgun worth catching in review rather than in a public repo.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { makeLocalBot, BOTS } from '../competitors/local.js';
import {
  AnthropicCompetitor,
  HttpCompetitor,
  OpenAICompetitor,
} from '../competitors/remote.js';
import type { Competitor } from '../competitors/types.js';

export const ADAPTERS = ['local', 'http', 'anthropic', 'openai'] as const;
export type Adapter = (typeof ADAPTERS)[number];

export interface RosterEntrant {
  name: string;
  adapter: Adapter;
  /** local */
  bot?: string;
  /** http */
  endpoint?: string;
  tokenEnv?: string;
  headers?: Record<string, string>;
  /** anthropic / openai */
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  systemPrompt?: string;
  maxTokens?: number;
}

export interface TeamFile {
  team: string;
  slug: string;
  contact: string;
  country?: string;
  motto?: string;
  entrants: RosterEntrant[];
  /** Where this came from, for error messages. */
  sourceFile?: string;
}

export interface RosterProblem {
  file: string;
  message: string;
}

export interface LoadedRoster {
  teams: TeamFile[];
  problems: RosterProblem[];
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Things that must never appear in a roster file. Better a noisy false positive
 * in review than a live key in git history.
 */
const CREDENTIAL_SHAPES: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{12,}/, 'an API key'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bAIza[A-Za-z0-9_-]{20,}/, 'a Google API key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/i, 'a bearer token'],
];

const SECRET_KEYS = new Set(['apikey', 'api_key', 'token', 'secret', 'password', 'key']);

function scanForSecrets(value: unknown, path: string, errors: string[]): void {
  if (typeof value === 'string') {
    for (const [shape, description] of CREDENTIAL_SHAPES) {
      if (shape.test(value)) {
        errors.push(`${path} looks like ${description}. Roster files name env vars, never values.`);
        return;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForSecrets(item, `${path}[${i}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase()) && typeof child === 'string') {
        errors.push(
          `${path}.${key} must not be set. Use "${key}Env" (or tokenEnv/apiKeyEnv) to name an environment variable instead.`,
        );
        continue;
      }
      scanForSecrets(child, `${path}.${key}`, errors);
    }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Validate one parsed roster file. Returns the team, or the reasons it failed. */
export function validateTeam(
  raw: unknown,
  file: string,
): { team?: TeamFile; errors: string[] } {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: ['file must contain a JSON object'] };
  }
  const input = raw as Record<string, unknown>;
  scanForSecrets(input, 'roster', errors);

  const team = asString(input['team']);
  if (!team) errors.push('"team" is required');
  else if (team.length > 60) errors.push('"team" must be 60 characters or fewer');

  const expectedSlug = basename(file, extname(file));
  const slug = asString(input['slug']);
  if (!slug) errors.push('"slug" is required');
  else if (!SLUG.test(slug)) errors.push(`"slug" must be lowercase-kebab-case, got "${slug}"`);
  else if (slug !== expectedSlug) {
    errors.push(`"slug" is "${slug}" but the file is named "${expectedSlug}". They must match.`);
  }

  const contact = asString(input['contact']);
  if (!contact) errors.push('"contact" is required (an email or a URL we can reach you at)');

  const rawEntrants = input['entrants'];
  const entrants: RosterEntrant[] = [];

  if (!Array.isArray(rawEntrants) || rawEntrants.length === 0) {
    errors.push('"entrants" must be a non-empty array');
  } else if (rawEntrants.length > 3) {
    errors.push('a team may enter at most 3 machines');
  } else {
    const seenNames = new Set<string>();
    rawEntrants.forEach((item, index) => {
      const where = `entrants[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const entry = item as Record<string, unknown>;

      const name = asString(entry['name']);
      if (!name) errors.push(`${where}.name is required`);
      else if (seenNames.has(name.toLowerCase())) {
        errors.push(`${where}.name "${name}" is used twice in this team`);
      } else seenNames.add(name.toLowerCase());

      const adapter = asString(entry['adapter']) as Adapter | undefined;
      if (!adapter || !ADAPTERS.includes(adapter)) {
        errors.push(`${where}.adapter must be one of: ${ADAPTERS.join(', ')}`);
        return;
      }

      const entrant: RosterEntrant = { name: name ?? `entrant-${index + 1}`, adapter };

      switch (adapter) {
        case 'local': {
          const bot = asString(entry['bot']);
          if (!bot) errors.push(`${where}.bot is required for the local adapter`);
          else if (!(bot in BOTS)) {
            errors.push(`${where}.bot "${bot}" is unknown. Known: ${Object.keys(BOTS).join(', ')}`);
          } else entrant.bot = bot;
          break;
        }
        case 'http': {
          const endpoint = asString(entry['endpoint']);
          if (!endpoint) errors.push(`${where}.endpoint is required for the http adapter`);
          else if (!/^https?:\/\//.test(endpoint)) {
            errors.push(`${where}.endpoint must be an http(s) URL`);
          } else entrant.endpoint = endpoint;

          const tokenEnv = asString(entry['tokenEnv']);
          if (tokenEnv) entrant.tokenEnv = tokenEnv;

          const headers = entry['headers'];
          if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
            entrant.headers = headers as Record<string, string>;
          }
          break;
        }
        case 'anthropic':
        case 'openai': {
          const model = asString(entry['model']);
          if (adapter === 'openai' && !model) {
            errors.push(`${where}.model is required for the openai adapter`);
          }
          if (model) entrant.model = model;
          const apiKeyEnv = asString(entry['apiKeyEnv']);
          if (apiKeyEnv) entrant.apiKeyEnv = apiKeyEnv;
          const baseUrl = asString(entry['baseUrl']);
          if (baseUrl) entrant.baseUrl = baseUrl;
          const systemPrompt = asString(entry['systemPrompt']);
          if (systemPrompt) entrant.systemPrompt = systemPrompt;
          const maxTokens = entry['maxTokens'];
          if (typeof maxTokens === 'number' && Number.isInteger(maxTokens) && maxTokens > 0) {
            entrant.maxTokens = maxTokens;
          }
          break;
        }
      }

      entrants.push(entrant);
    });
  }

  if (errors.length > 0) return { errors };

  const result: TeamFile = {
    team: team!,
    slug: slug!,
    contact: contact!,
    entrants,
    sourceFile: file,
  };
  const country = asString(input['country']);
  if (country) result.country = country;
  const motto = asString(input['motto']);
  if (motto) result.motto = motto;

  return { team: result, errors: [] };
}

/** Read and validate every roster file in a directory. */
export async function loadRoster(directory: string): Promise<LoadedRoster> {
  const teams: TeamFile[] = [];
  const problems: RosterProblem[] = [];

  let files: string[];
  try {
    files = (await readdir(directory)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { teams, problems: [{ file: directory, message: 'roster directory not found' }] };
  }

  for (const file of files) {
    const full = join(directory, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(full, 'utf8'));
    } catch (error) {
      problems.push({ file, message: `not valid JSON: ${(error as Error).message}` });
      continue;
    }

    const { team, errors } = validateTeam(parsed, file);
    for (const message of errors) problems.push({ file, message });
    if (team) teams.push(team);
  }

  const seenSlugs = new Map<string, string>();
  for (const team of teams) {
    const previous = seenSlugs.get(team.slug);
    if (previous) {
      problems.push({ file: team.sourceFile ?? team.slug, message: `slug also used by ${previous}` });
    }
    seenSlugs.set(team.slug, team.sourceFile ?? team.slug);
  }

  return { teams, problems };
}

/** Turn validated roster entries into things that can run a yard. */
export function buildCompetitors(teams: TeamFile[], seed: string): Competitor[] {
  const competitors: Competitor[] = [];

  for (const team of teams) {
    team.entrants.forEach((entrant, index) => {
      const id = `${team.slug}-${index + 1}`;
      const base = { id, name: entrant.name, team: team.team, teamSlug: team.slug };

      switch (entrant.adapter) {
        case 'local':
          competitors.push(makeLocalBot({ ...base, bot: entrant.bot!, seed }));
          break;
        case 'http':
          competitors.push(
            new HttpCompetitor({
              ...base,
              endpoint: entrant.endpoint!,
              ...(entrant.tokenEnv ? { tokenEnv: entrant.tokenEnv } : {}),
              ...(entrant.headers ? { headers: entrant.headers } : {}),
            }),
          );
          break;
        case 'anthropic':
          competitors.push(
            new AnthropicCompetitor({
              ...base,
              ...(entrant.model ? { model: entrant.model } : {}),
              ...(entrant.apiKeyEnv ? { apiKeyEnv: entrant.apiKeyEnv } : {}),
              ...(entrant.baseUrl ? { baseUrl: entrant.baseUrl } : {}),
              ...(entrant.systemPrompt ? { systemPrompt: entrant.systemPrompt } : {}),
              ...(entrant.maxTokens ? { maxTokens: entrant.maxTokens } : {}),
            }),
          );
          break;
        case 'openai':
          competitors.push(
            new OpenAICompetitor({
              ...base,
              model: entrant.model!,
              ...(entrant.apiKeyEnv ? { apiKeyEnv: entrant.apiKeyEnv } : {}),
              ...(entrant.baseUrl ? { baseUrl: entrant.baseUrl } : {}),
              ...(entrant.systemPrompt ? { systemPrompt: entrant.systemPrompt } : {}),
              ...(entrant.maxTokens ? { maxTokens: entrant.maxTokens } : {}),
            }),
          );
          break;
      }
    });
  }

  return competitors;
}
