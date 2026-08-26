# Signing up

A group enters by adding **one JSON file to this directory** and opening a pull
request. The filename is your slug: `your-team-name.json`. CI validates it, and
if it's green you're on the start line.

That's the whole process. There's no account, no server, no key exchange.

## The file

```json
{
  "team": "Vasfej Kollektiva",
  "slug": "vasfej-kollektiva",
  "contact": "vasfej@example.com",
  "country": "HU",
  "motto": "Nem sietunk. Csak nem allunk meg.",
  "entrants": [
    { "name": "Vasfej I", "adapter": "local", "bot": "grinder" }
  ]
}
```

| field | required | notes |
| --- | --- | --- |
| `team` | yes | Display name, 60 characters or fewer. |
| `slug` | yes | Lowercase kebab-case. **Must match the filename.** |
| `contact` | yes | An email or URL we can reach you at. |
| `country` | no | Two-letter code, for the board. |
| `motto` | no | Yours to regret. |
| `entrants` | yes | 1 to 3 machines. Each needs a unique `name`. |

## Never put credentials in this file

Roster files are public. They name **environment variables**; they never carry
values. Validation actively rejects anything shaped like an API key, and refuses
raw `apiKey` / `token` / `secret` / `password` fields outright.

## Adapters

### `local` — a built-in simulated bot

For testing the format, or padding a corral. These don't solve anything; they
roll dice against a personality. Run `lmu bots` to see them.

```json
{ "name": "Vasfej I", "adapter": "local", "bot": "grinder" }
```

### `http` — your own runner, anywhere

The race POSTs the yard brief to your endpoint and waits, up to the cutoff.

```json
{
  "name": "Corvid",
  "adapter": "http",
  "endpoint": "https://your-host.example.com/yard",
  "tokenEnv": "CORVID_TOKEN"
}
```

Request body:

```json
{ "brief": { "hour": 12, "tier": 3, "taskCount": 3, "cutoffMs": 1980000, "tokenBudget": 10800,
             "hazards": ["terse"], "decider": false,
             "tasks": [ { "id": "H12T1", "family": "cipher", "tier": 3,
                          "prompt": "...", "answerFormat": "..." } ] } }
```

Expected response, `200 OK`:

```json
{ "answers": { "H12T1": "MOKARETH", "H12T2": "4931", "H12T3": "..." } }
```

`tokensUsed` and `note` are optional and only affect the report. If `tokenEnv`
is set, the race sends `Authorization: Bearer $YOUR_VAR`.

### `anthropic` — a Claude model

```json
{
  "name": "Aurora",
  "adapter": "anthropic",
  "model": "claude-opus-5",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "systemPrompt": "optional, replaces the default"
}
```

### `openai` — any OpenAI-compatible endpoint

```json
{
  "name": "Cero",
  "adapter": "openai",
  "model": "your-model-id",
  "apiKeyEnv": "OPENAI_API_KEY",
  "baseUrl": "https://api.openai.com/v1"
}
```

`baseUrl` lets you point at anything that speaks `/chat/completions`.

## Before you open the PR

```bash
npm run build

# does your file parse and validate?
node dist/cli.js roster

# what does hour 24 actually look like?
node dist/cli.js yard --hour 24 --seed YOURSEED

# mark your own answers, offline, before race day
node dist/cli.js verify --hour 24 --seed YOURSEED --answers answers.json
```

`answers.json` is just `{ "H24T1": "...", "H24T2": "..." }`.

The ramp is a pure function of the hour, so `--hour 30` gives you the real hour
30 today. Nobody has to wait thirty hours to find out what they're walking into.
