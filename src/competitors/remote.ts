/**
 * Live entrants: things that are actually somewhere else.
 *
 * Three adapters, all built on `fetch` with no dependencies:
 *
 *   http        POST the brief as JSON to a URL your team controls.
 *   anthropic   send the brief to the Claude Messages API.
 *   openai      send the brief to any OpenAI-compatible chat endpoint.
 *
 * All three honour the abort signal, because a yard that runs past the cutoff
 * is over whether or not the entrant has noticed. Credentials are only ever
 * read from the environment - a roster file names an environment variable, it
 * never carries a key.
 */

import type { Submission, YardBrief } from '../core/types.js';
import { SYSTEM_PROMPT, parseAnswers, renderBrief } from './prompting.js';
import type { Competitor, RunContext } from './types.js';

interface BaseOptions {
  id: string;
  name: string;
  team: string;
  teamSlug: string;
}

function requireEnv(variable: string, adapter: string): string {
  const value = process.env[variable];
  if (!value) {
    throw new Error(
      `${adapter} entrant needs ${variable} in the environment, and it is unset or empty`,
    );
  }
  return value;
}

/** Reject as soon as the cutoff passes, whatever the remote end is doing. */
async function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('cutoff reached');
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cutoff reached')), { once: true });
    }),
  ]);
}

/**
 * A team's own runner, behind an HTTP endpoint.
 *
 * Request:  POST { brief }              (the brief is exactly a YardBrief)
 * Response: 200  { answers: { taskId: string }, note?: string, tokensUsed?: number }
 */
export class HttpCompetitor implements Competitor {
  readonly kind = 'http';
  readonly id: string;
  readonly name: string;
  readonly team: string;
  readonly teamSlug: string;

  constructor(
    options: BaseOptions & {
      endpoint: string;
      /** Name of the env var holding a bearer token. Never the token itself. */
      tokenEnv?: string;
      headers?: Record<string, string>;
    },
  ) {
    this.id = options.id;
    this.name = options.name;
    this.team = options.team;
    this.teamSlug = options.teamSlug;
    this.endpoint = options.endpoint;
    this.tokenEnv = options.tokenEnv;
    this.headers = options.headers ?? {};
  }

  private readonly endpoint: string;
  private readonly tokenEnv: string | undefined;
  private readonly headers: Record<string, string>;

  async run(brief: YardBrief, ctx: RunContext): Promise<Submission> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.headers,
    };
    if (this.tokenEnv) headers['authorization'] = `Bearer ${requireEnv(this.tokenEnv, 'http')}`;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ brief }),
      signal: ctx.signal,
    });

    if (!response.ok) {
      throw new Error(`endpoint returned ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as Partial<Submission> | undefined;
    if (!payload || typeof payload.answers !== 'object' || payload.answers === null) {
      throw new Error('response had no "answers" object');
    }

    const answers: Record<string, string> = {};
    for (const task of brief.tasks) {
      const value = (payload.answers as Record<string, unknown>)[task.id];
      answers[task.id] = typeof value === 'string' ? value : value === undefined ? '' : String(value);
    }

    const submission: Submission = { answers };
    if (typeof payload.tokensUsed === 'number') submission.tokensUsed = payload.tokensUsed;
    if (typeof payload.note === 'string') submission.note = payload.note;
    return submission;
  }
}

/** An entrant that is a Claude model. */
export class AnthropicCompetitor implements Competitor {
  readonly kind = 'anthropic';
  readonly id: string;
  readonly name: string;
  readonly team: string;
  readonly teamSlug: string;

  constructor(
    options: BaseOptions & {
      model?: string;
      apiKeyEnv?: string;
      baseUrl?: string;
      systemPrompt?: string;
      maxTokens?: number;
    },
  ) {
    this.id = options.id;
    this.name = options.name;
    this.team = options.team;
    this.teamSlug = options.teamSlug;
    this.model = options.model ?? 'claude-opus-5';
    this.apiKeyEnv = options.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
    this.maxTokens = options.maxTokens;
  }

  private readonly model: string;
  private readonly apiKeyEnv: string;
  private readonly baseUrl: string;
  private readonly systemPrompt: string;
  private readonly maxTokens: number | undefined;

  async run(brief: YardBrief, ctx: RunContext): Promise<Submission> {
    const response = await withDeadline(
      fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': requireEnv(this.apiKeyEnv, 'anthropic'),
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          // The yard's token budget is the entrant's allowance for the hour, so
          // it is also the natural output ceiling.
          max_tokens: this.maxTokens ?? Math.max(1024, brief.tokenBudget),
          system: this.systemPrompt,
          messages: [{ role: 'user', content: renderBrief(brief) }],
        }),
        signal: ctx.signal,
      }),
      ctx.signal,
    );

    if (!response.ok) {
      throw new Error(`anthropic returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const reply = (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');

    const submission: Submission = {
      answers: parseAnswers(reply, brief.tasks.map((t) => t.id)),
    };
    const usage = payload.usage;
    if (usage) {
      submission.tokensUsed = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    }
    return submission;
  }
}

/** An entrant behind any OpenAI-compatible `/chat/completions` endpoint. */
export class OpenAICompetitor implements Competitor {
  readonly kind = 'openai';
  readonly id: string;
  readonly name: string;
  readonly team: string;
  readonly teamSlug: string;

  constructor(
    options: BaseOptions & {
      model: string;
      apiKeyEnv?: string;
      baseUrl?: string;
      systemPrompt?: string;
      maxTokens?: number;
    },
  ) {
    this.id = options.id;
    this.name = options.name;
    this.team = options.team;
    this.teamSlug = options.teamSlug;
    this.model = options.model;
    this.apiKeyEnv = options.apiKeyEnv ?? 'OPENAI_API_KEY';
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
    this.maxTokens = options.maxTokens;
  }

  private readonly model: string;
  private readonly apiKeyEnv: string;
  private readonly baseUrl: string;
  private readonly systemPrompt: string;
  private readonly maxTokens: number | undefined;

  async run(brief: YardBrief, ctx: RunContext): Promise<Submission> {
    const response = await withDeadline(
      fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${requireEnv(this.apiKeyEnv, 'openai')}`,
        },
        body: JSON.stringify({
          model: this.model,
          max_completion_tokens: this.maxTokens ?? Math.max(1024, brief.tokenBudget),
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: renderBrief(brief) },
          ],
        }),
        signal: ctx.signal,
      }),
      ctx.signal,
    );

    if (!response.ok) {
      throw new Error(`openai returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
    };

    const reply = payload.choices?.[0]?.message?.content ?? '';
    const submission: Submission = {
      answers: parseAnswers(reply, brief.tasks.map((t) => t.id)),
    };
    if (typeof payload.usage?.total_tokens === 'number') {
      submission.tokensUsed = payload.usage.total_tokens;
    }
    return submission;
  }
}
