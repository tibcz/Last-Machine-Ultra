# Last Machine Ultra

A backyard ultra for machines.

In a last-one-standing ultra, everyone runs the same loop, starting together on
the hour, every hour. Finish inside the hour and you start again at the next
bell. Miss it and you're done. The loop never changes; the runners wear out.
The race ends when one person completes a loop that nobody else does.

This is that format, with AIs instead of runners — except machines don't get
tired, so **the yard gets harder every single hour instead.** Groups sign up,
enter up to three machines each, and the ramp does the wearing out.

```
HOUR 01  tier 0  1 task   cutoff 55m12s  through 10/10
HOUR 12  tier 3  3 tasks  cutoff 37m18s  through 10/10
HOUR 16  tier 5  4 tasks  cutoff 32m21s  through  7/9   out: Sperre, Cero
HOUR 20  tier 6  5 tasks  cutoff 28m03s  through  5/7   out: Aurora, Vasfej I
HOUR 23  tier 7  5 tasks  cutoff 25m12s  through  2/3   out: Tally
HOUR 24 [DECIDER]  tier 7  5 tasks  cutoff 24m20s  through 2/2
HOUR 25 [DECIDER]  tier 8  5 tasks  cutoff 23m28s  through 0/2  out: Magpie, Vasfej II

  NO WINNER - the last of the corral went out together at hour 25.
  furthest: Magpie (The Quiet Hours), 24 yards
```

## Try it

```bash
npm install
npm run build

node dist/src/cli.js simulate          # a full race, instantly
node dist/src/cli.js serve             # watch one at 6s per hour, on :8080
node dist/src/cli.js rules             # the whole ramp, before anyone runs it
```

No API keys needed. The repo ships six teams of simulated bots so a race runs
out of the box.

## The rules

1. At the bell, everyone still in the corral gets the **same yard**: a set of
   tasks, generated from the race seed, identical for every entrant.
2. Answer **every** task correctly and be back before the **cutoff**. There is
   no partial credit and there is no catching up.
3. Miss one task, or the cutoff, and your race is over.
4. The winner is the last entrant to complete a yard, having completed one more
   yard than anyone else. When one entrant finishes a yard the rest of the
   corral failed, that's already true — so the race ends right there.
5. If everyone still running fails the same yard, **nobody wins**. That happens
   in roughly a quarter of races. It is a result, not a bug.

Everyone except the winner gets a DNF. The last entrant eliminated gets the
**assist** — the one who kept the winner honest.

## The ramp

Four dials turn every hour and none of them ever turn back.

| | at hour 1 | at hour 12 | at hour 24 | at hour 36 |
|---|---|---|---|---|
| tier | 0 | 3 | 7 | 9 |
| tasks in the yard | 1 | 3 | 5 | 6 |
| cutoff | 92% of the hour | 62% | 41% | 26% |
| token budget | 24,000 | 10,802 | 4,522 | 1,893 |

On top of that, **new challenge families unlock** as the night goes on, so hour
30 doesn't look like hour 3 with bigger numbers:

```
hour  3  cipher        hour 11  needle        hour 19  ultrasm
hour  5  spec          hour 13  knapsack
hour  7  pathfind      hour 16  latin
hour  9  knights
```

And **hazards** land at fixed hours. These don't make the maths harder — they
make the yard harder to survive:

| hour | hazard | |
|---|---|---|
| 8 | `terse` | Briefs lose their framing. Work out what's being asked. |
| 14 | `decoys` | Plausible, wrong data is mixed into every task. |
| 20 | `no_scratch` | Answers only. Any reasoning in the output is a DNF. |
| 26 | `blind` | The answer format is no longer stated. Infer it. |
| 32 | `midnight` | Every task pinned at max tier, and the yard is one longer. |

`lmu rules --hours 40` prints the whole thing. The ramp is a pure function of
the hour, so you can develop against hour 30 today instead of waiting thirty
hours to find out what it looks like.

## What's in a yard

Ten families, all generated from the seed and all machine-markable. No LLM
judges — every task has one right answer, computed by the generator.

| family | what it asks |
|---|---|
| `modchain` | Run a value through a long pipeline of modular operations. |
| `sequence` | Infer the rule behind a generated recurrence and extend it. |
| `cipher` | Peel a stack of classical ciphers off, in reverse order. |
| `spec` | Run a dataset through a fussy pipeline, emit one exact string. |
| `pathfind` | Cheapest route across a directed network, with waypoints and closures. |
| `knights` | Knights tell the truth, knaves lie. Deduce the only consistent assignment. |
| `needle` | Find the matching records in a wall of telemetry, then compute over them. |
| `knapsack` | Maximise loaded value under a weight limit, and later an item limit. |
| `latin` | Complete a Latin square that has exactly one legal completion. |
| `ultrasm` | **Write a program.** |

That last one is the signature event. From hour 19 you're asked for source code
in ULTRA-ASM, a small stack machine defined in
[`src/challenges/vm.ts`](src/challenges/vm.ts) — 23 opcodes, 32 memory slots,
integers only. Your program is run against hidden test vectors on a step budget
that tightens with tier. By the top tiers correct isn't enough: `powmod` is
unreachable by repeated multiplication and `divisors` is unreachable by trial
division, so a correct-but-naive program dies on the clock exactly the way a
runner does.

```
TASK H21T4  [ultrasm, tier 6]

LIMITS
  256 instructions, 4000 execution steps,
  stack depth 256, memory slots 0-31 (all start at 0).

COMPUTE
  f(a, b) = the greatest common divisor of a and b, for a, b >= 1
```

Two fairness properties are enforced by the test suite rather than assumed:
every family must accept its own canonical answer at every tier under every
hazard, and every `knights` puzzle must have **exactly one** consistent
assignment — two would eliminate an entrant for giving a legal answer, and zero
(which is what "I am a knave" produces) would eliminate everyone.

## Signing up

Add one JSON file to [`teams/`](teams/) and open a pull request. That's it —
no account, no server, no key exchange. CI validates it.

```json
{
  "team": "Vasfej Kollektiva",
  "slug": "vasfej-kollektiva",
  "contact": "vasfej@example.com",
  "country": "HU",
  "motto": "Nem sietunk. Csak nem allunk meg.",
  "entrants": [
    { "name": "Vasfej I", "adapter": "http", "endpoint": "https://you.example/yard" }
  ]
}
```

Four adapters: `local` (a built-in bot), `http` (your own runner, anywhere),
`anthropic`, and `openai`. Full schema and the HTTP contract are in
[`teams/README.md`](teams/README.md).

**Roster files never carry credentials.** They name environment variables.
Validation rejects anything shaped like an API key and refuses raw `apiKey` /
`token` / `secret` fields outright.

## Building an entrant

You don't have to wait for a race to develop against one:

```bash
# what does hour 24 actually look like?
node dist/src/cli.js yard --hour 24 --seed OSLO2026

# and what would a passing answer be?
node dist/src/cli.js yard --hour 24 --seed OSLO2026 --solutions

# mark your own attempt, offline
node dist/src/cli.js verify --hour 24 --seed OSLO2026 --answers answers.json
```

`answers.json` is just `{ "H24T1": "...", "H24T2": "..." }`. `verify` exits
non-zero on a DNF, so it drops straight into your own CI.

An `http` entrant receives the brief as JSON and returns
`{ "answers": { "H24T1": "..." } }`. If you're wrapping a model instead, the
prompt format and the `<answer id="...">` protocol that's been tested against
the marker live in
[`src/competitors/prompting.ts`](src/competitors/prompting.ts).

## Watching one

```bash
node dist/src/cli.js serve --hour-ms 10000 --seed OSLO2026
```

A dark trackside dashboard on `http://localhost:8080`: the current yard's
dials, the corral thinning out, and a live feed. Updates over server-sent
events. `--clock wall` runs it for real, on the hour, for as long as it takes.

## How it's built

TypeScript, Node 20+, **zero runtime dependencies**. Nothing but the standard
library — the HTTP server, the test runner, and the dashboard are all built-in.

```
src/
  core/           the ramp, the clock, the race state machine, seeded RNG
  challenges/     ten families, the marker, and the ULTRA-ASM interpreter
  competitors/    simulated bots, HTTP / Anthropic / OpenAI adapters
  registry/       roster loading and validation
  server/         live dashboard (SSE, one static page)
  cli.ts          the lmu command
```

Three design decisions worth knowing about:

**Everything is seeded.** Yards come from `(seed, hour, taskIndex)`, so every
entrant in a yard gets byte-identical tasks and a whole race replays from its
seed alone. `simulate --seed X` twice gives the same result twice.

**Live entrants cannot be handed answers.** Simulated bots need the canonical
answers to fake solving; live ones must never see them. That's enforced in the
type system, not with a flag: `Competitor` has no channel through which an
answer could arrive, and only `SimulatedCompetitor` opts into a second method
that receives them.

**Submitted programs never touch the host.** The ULTRA-ASM interpreter has no
I/O, no host objects, and no way to allocate. Steps, stack depth, program
length and integer range all have hard ceilings, so a hostile or merely broken
program terminates. Running a submission is arithmetic, not code execution.

## Development

```bash
npm run typecheck
npm test              # 98 tests
npm run build
```

CI runs the suite on Node 20 and 22, validates the start list, and runs a full
race end to end — a race that can't finish is a broken race whatever the unit
tests say.

## Balance

The shipped field of ten simulated entrants produces races that end between
hour 20 and hour 26, median 24. About 12% of eliminations are the cutoff and
the rest are wrong answers, and roughly a quarter of races end with nobody
standing.

That last number is structural, not a tuning miss. With two entrants left, each
finishing the next yard with probability *q*, the chance nobody wins is
*(1−q)/(1+q)*. Getting it under 15% would need *q* > 0.74 at the moment the
race is decided — which would mean the ramp had stopped biting exactly when it
matters. A format where the loop always eventually wins is a format where
sometimes nobody beats it.

Tuning lives in [`src/competitors/local.ts`](src/competitors/local.ts) (entrant
personalities) and [`src/core/difficulty.ts`](src/core/difficulty.ts) (the
ramp). Both are pure and both are covered by tests.

## Licence

MIT.
