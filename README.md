# Mimo — Every book deserves to be played

Turn any children's book into an interactive adventure, with an original companion creature
who lives inside the story alongside the child.

> **Never read alone.**

Built for a one-day ClickHouse hackathon. The thesis: children don't need another reading
worksheet — they need a reason to keep reading. So we make the book playable, and we use a real
behavioural event stream to learn where each child struggles, what keeps them engaged, and
which kind of help actually works *for them*.

---

## The causal loop (the whole point)

```
CHILD PLAYS
    ↓  every tap, drag, hesitation and reading attempt
CLICKHOUSE          gameplay_events + materialized views
    ↓  real SQL, no hardcoded answers
CHILD PROFILE       weak patterns, preferred mechanics, what help works
    ↓
ADAPTATION PLAN
    ↓
THE NEXT SCENE ACTUALLY CHANGES
```

Nothing in that loop is simulated. If ClickHouse has no rows, the profile says so and the game
does not adapt — it never invents a finding.

## Architecture

| Layer | Responsibility | Answers |
|---|---|---|
| **Postgres / SQLite** | children, stories, generated adventures, progress | *What exists now?* |
| **ClickHouse** | immutable behavioural event stream | *What happened?* |
| **Story Engine** (Phaser) | renders any validated story JSON | *What does the child see?* |
| **LLM** | book text → structured, validated story JSON | *How does a book become playable?* |
| **LibreChat tools** | conversational access to the real analytics | *Why is this child struggling?* |

## Design constraints worth knowing

- **No art or audio assets exist in this repo, and none are downloaded.** Every environment,
  character, prop and particle is drawn procedurally with Phaser `Graphics`. Every sound is
  synthesised with WebAudio oscillators. `src/game/art/contract.ts` is the seam.
- **The LLM never emits code.** It picks *content and configuration* only, choosing from seven
  approved interaction primitives. Output is validated by `src/shared/storySchema.ts`, including
  cross-reference checks (every interaction must point at props that actually exist, every
  `nextScene` must resolve). Invalid stories are sent back for repair, never rendered.
- **Analytics can never break gameplay.** Events batch client-side, and if ClickHouse is
  unreachable they land in a durable on-disk queue (`.data/event-queue.jsonl`) and replay
  automatically on reconnect.

## The seven interaction primitives

`tap_target` · `choose_object` · `drag_drop` · `collect_items` · `path_choice` ·
`reading_choice` · `simple_character_action`

This is what makes arbitrary books reliable: "Jack climbed the beanstalk" becomes
`simple_character_action`, "the princess found three keys" becomes `collect_items`, "the BLUE
butterfly knows the way" becomes `choose_object`.

## Running it

```bash
npm install
```

Copy `.env.example` to `.env` and fill in what you have. **Every key is optional** — each
missing one degrades to an explicit "not configured" state in the UI rather than a fake result.

```bash
npm run dev
```

- Child experience — http://localhost:5173/
- Teacher / parent view — http://localhost:5173/#/teacher
- Live ClickHouse proof view — http://localhost:5173/#/dev
- API — http://localhost:8787/api/status

### What each credential unlocks

| Variable | Unlocks | Without it |
|---|---|---|
| `CLICKHOUSE_HOST` / `_PASSWORD` | analytics, pattern detection, adaptation | events queue to disk and replay later; profile reports no evidence |
| `ANTHROPIC_API_KEY` | book → playable adventure | the "Make it playable" button is disabled with a stated reason |
| `DATABASE_URL` | Postgres for operational state | embedded SQLite at `.data/storybook.db` |

The built-in demo story works with **no credentials at all**.

## Verifying it is real

```bash
npm run validate:stories
```

```bash
npm run test:pipeline
```

The pipeline test emits a realistic stream of failed and successful reading attempts, then
asserts that the *query* discovers the weak pattern — it never asserts against a hardcoded
answer, and it fails loudly if it finds a hardcoded pattern anywhere in the services.

```bash
npx tsx scripts/ch-inspect.ts
```

Prints live row counts straight from ClickHouse so you can confirm data actually landed.

## The demo story

**The Fox and the Lost Star** — five scenes, playable without any external service:

1. **The falling star** — a star streaks across an enchanted forest at dusk *(tap_target)*
2. **The river** — gather three stones so the fox can cross *(collect_items)*
3. **The butterflies** — the BLUE one knows the way *(choose_object)*
4. **The cave** — the BRAVE fox crossed the BRIDGE and followed the BROWN footprints *(reading_choice)*
5. **Return the star** — drag it back into the night sky *(drag_drop)*

Scene 4 is where reading intelligence happens. The BR words are deliberately chosen so that a
child who struggles produces genuine evidence — and the ClickHouse query has to *discover* the
BR pattern on its own.

## Mimo

An original creature: small, round, oversized eyes, two soft antenna-ears with glowing tips that
droop when sad and perk up when excited. Warm mint and cream. Drawn entirely from primitives.

Mimo is not a chat panel bolted to the side of a book. Mimo enters the scene, follows the fox,
hops, points, hides, gets startled, and celebrates. Mimo talks about the *adventure* —
friend first, tutor second.

Mimo also learns. The system measures whether a hint actually improved the next attempt, per
child, and adjusts when Mimo offers help. A child who succeeds on their own by the third try
gets left alone until then. A child who disengages after repeated failure gets help sooner.
