# sangkhem — Conductor design (v1)

Date: 2026-09-25
Status: revised after review, awaiting spec approval

## Goal

Make roleplay in SillyTavern better by coordinating several small, specialised
helpers around one frontier "narrator" model, instead of relying on one large
model and one large prompt.

The idea comes from a SillyTavern community comment: nobody is going to train a
trillion-parameter RP model, so the realistic path is layered orchestration —
small systems for embedding, recall, classification and direction, handing off
to a frontier model for the final narration.

sangkhem is that orchestration layer, shipped as a SillyTavern extension that
anyone can install by URL.

## Background: what already exists

The author's SillyTavern install (1.16.0) already has most of the individual
parts. None of them coordinate; each hooks generation on its own.

| Layer | Existing piece | Notes |
|---|---|---|
| Recall / memory | Summaryception (third party) | Stores layered summaries in `chatMetadata.summaryception`, injects them itself |
| Recall / memory | SnapCompact (author's) | Sends the Summaryception summary and tagged lore as images to save tokens |
| Classification | Laya WI Director (author's) | Local Laya model scores keyword-matched World Info entries and prunes low-value ones; also has a reply guard |
| Narration | Frontier models via custom proxy + Ellen Joe preset | CoT Guard enforces the preset's CoT tags, auto-swiping on failure |
| Post-processing | Recast (third party) | Multi-pass rewrite of each reply |
| Direction | — | Nothing directs plot, pacing or scenes |
| Scene state | — | Nothing tracks location, outfits, who is present |

The missing piece is the conductor: shared state, and one place that runs the
helpers in order and hands the narrator a clean brief.

## Scope

### v1 includes

- A standalone SillyTavern extension (this repo).
- A stage pipeline with two phases, Plan and Observe.
- Four stages: Memory, Lore and Brief (Plan), and Scene (Observe).
- Pluggable backends with one real implementation and one null implementation
  per slot.
- Per-message scene state with evidence-gated updates and provenance.
- A brief injected into the prompt, a settings panel, a turn inspector, a scene
  panel and slash commands.
- A scene-extraction eval tool.

### v1 does not include (future work, same interfaces)

- Director stage (plot threads, pacing, next-beat suggestions).
- Narrator tool calls (`recall_memory`, `check_state`, `lookup_lore`) via
  `registerFunctionTool`.
- Reply guard as an Observe stage (port of Laya WI Director's `/reply-guard`
  and `/echo-check`). Until then the standalone extension's guard keeps working.
- More memory sources (qvink MessageSummarize, others).
- More lore scorers: Jev (the author has used it as a pick-from-options decision
  model in jev-use) or any LLM through a connection profile.
- Built-in fallback memory for users without a summary extension.
- Post-processing stages.
- Parallel stage execution (see "Latency").
- SnapCompact integration, opt-in (for example imaging the brief or the Memory
  stage's output). v1 only coexists with SnapCompact.
- An automated continuity A/B harness.
- Fine-tuned helper models.

## Success criteria

v1 is worth keeping if all of these hold:

1. **Scene extraction is accurate.** With the chosen helper model,
   `tools/eval-scene.mjs` reports at least 90% field accuracy on the fixture
   set, and the evidence gate accepts no change that lacks a real quote.
2. **Continuity improves.** Manual A/B on two cards the author plays: a
   50-turn session with sangkhem off and a 50-turn session with it on, counting
   continuity errors (wrong location, wrong outfit or condition, a character
   present who left or absent who is there, a forgotten open thread). Fewer
   errors with sangkhem on. These counts are also the baseline for judging the
   Director later.
3. **It is cheap in time.** Added Plan latency, from the inspector's session
   stats: p95 at most 1.5 s with local Laya, and under 50 ms with Lore off.
   Observe adds no time before the narrator in the default trigger mode.
4. **Token cost is known.** The inspector reports prompt tokens added (brief)
   and removed (lore pruning) per turn, so the net effect is visible.
5. **It never breaks generation.** Every failure test (service down, stage
   throws, stage hangs, malformed model output, chat switch mid-turn) ends with
   a normal narrator reply.

## Architecture

### Turn flow

```
 user sends message
        │
        ▼
 ┌─ PLAN phase (generate_interceptor, before narrator) ──────────┐
 │  load scene state (observe latest reply now if it has none)   │
 │  run plan stages in order:  Memory ─▶ Lore ─▶ Brief           │
 │  inject brief                                                 │
 └───────────────────────────────────────────────────────────────┘
        │
        ▼
 narrator (frontier model, user's preset) writes reply
        │
        ▼
 ┌─ OBSERVE phase (after the reply settles, async) ──────────────┐
 │  run observe stages:  Scene                                   │
 │  save new state onto that message                             │
 └───────────────────────────────────────────────────────────────┘
```

Plan runs before the narrator, so it adds latency; it stays light. Observe runs
after the reply is on screen, while the user reads and types, so by default it
adds none. Heavier work (small-model extraction) belongs in Observe.

### Load order and event order

Two SillyTavern behaviours decide how sangkhem interacts with other extensions:

- Generate interceptors run in manifest `loading_order`, then by display name
  (`extensions.js`).
- `eventSource.emit` awaits each listener in turn, in registration order, and
  extensions register in load order (`lib/eventemitter.js`).

sangkhem uses **`loading_order: 200`**, after every extension in the author's
install (the highest today is 100). This means:

- Its interceptor runs after interceptors that change the chat (Vector Storage,
  qvink, Megumin Suite), so the Lore stage's dry-run scan sees the final chat.
- Its `MESSAGE_RECEIVED` listener runs after Recast's (`loading_order: 9`),
  which awaits its whole rewrite. Observe therefore sees the rewritten text,
  not the draft.

`MESSAGE_RECEIVED` is itself awaited when generation finishes. sangkhem's
listener only schedules Observe and returns at once; it never awaits the
extraction.

### Stage contract

Every stage, now and later, is an object:

```js
{
  id: 'lore',
  phase: 'plan',               // 'plan' | 'observe'
  available(ctx) { ... },      // boolean: dependencies present and reachable?
  async run(turn, state, config) {
    return { statePatch, output }; // both optional
  },
}
```

- `turn` carries the chat array, the generation type, an `AbortSignal`, and
  `outputs`: earlier stages' `output`, keyed by stage id. For example, Lore
  reads `turn.outputs.memory.summary`.
- `state` is the current scene state (read-only for Plan stages in v1).
- `config` is the stage's own settings slice.
- Stages run one after another in registration order within a phase.

### Pluggable backends

Stages that talk to other systems do so through small adapters, so new ones can
be added without touching the stage. Each slot ships a real backend and a
`none` backend. `none` is always available and returns nothing. It is the
fallback when the real backend is missing, and the tests use it to prove that
stages and the interface do not assume Summaryception or Laya.

- **Memory source**: `{ id, available(ctx), getSummary(ctx) → string | null }`.
  v1: `summaryception`, `none`.
- **Lore scorer**: `{ id, available(ctx), async score(candidates, context, { serviceUrl, signal }) → [{ id, relevance, usefulness }] }`,
  where `id` is `<world>.<uid>`.
  v1: `laya`, `none` (`none` keeps every entry, which is native ST behaviour).
- **LLM calls** (used by Scene, and later by others) go through
  `ConnectionManagerRequestService.sendRequest(profileId, …)`, so each stage can
  use any saved connection profile: local LM Studio, a free OpenRouter model, or
  a paid API. This is how per-layer cost and latency are made configurable.

## Coexistence with existing extensions

What sangkhem does with each piece, and what the user has to change.

| Piece | sangkhem | User action |
|---|---|---|
| Summaryception | **Reads** its store for the Memory stage. Never injects the summary itself, so nothing is doubled. | None. Keep it enabled. |
| SnapCompact | **Leaves alone.** The summary is only injected by Summaryception, so SnapCompact still images it and the savings stay. The brief is ordinary text and is not imaged. | None. |
| Laya WI Director: lore pruning | **Replaces** it with the Lore stage. If the standalone director is on (`extension_settings.laya_wi_director.enabled`), the Lore stage turns itself off and the panel warns, so lore is never pruned twice. | Turn off "Enable" in Laya WI Director. |
| Laya WI Director: reply guard | **Leaves alone.** It keeps working against the same service. | Keep `guardEnabled` as wanted. |
| Laya service | **Uses** it (`/wi-director`, `/health`). The repo ships an identical copy. | Run either copy on `:8666`. |
| Recast | **Leaves alone.** Observe reads the text after Recast's rewrite (see "Load order"). | None. |
| CoT Guard | **Leaves alone.** Observe waits for the reply to settle and cancels if it is swiped, so rejected replies are not extracted. | None. |
| ST reasoning / CoT tags | Observe reads `message.mes` only (never `extra.reasoning`) and, within it, only story text (see Scene stage). | None. |
| Vector Storage, qvink, Megumin Suite | **Leaves alone.** Their interceptors run before sangkhem's. | None. |

## Scene state

### Schema (v1)

Kept small so a small model can produce it reliably.

```json
{
  "v": 1,
  "location": "Ellen's apartment, kitchen",
  "time": "late evening, raining",
  "present": [
    { "name": "Ellen", "outfit": "oversized hoodie", "condition": "tired", "mood": "annoyed" }
  ],
  "threads": ["owes {{user}} a favor", "shark plushie still missing"]
}
```

- All string fields may be empty. `present` and `threads` may be empty arrays.
- `threads` holds open plot threads and promises, capped at a configurable
  length (default 8).
- Fields can be switched off in settings; disabled fields are left out of the
  extraction prompt and the brief.

### Storage

State is stored on each AI message at `message.extra.conductor`:

```js
message.extra.conductor = {
  state,            // the schema above
  provenance,       // field path → { mesId, quote } (see below)
  updatedAt,        // ISO timestamp
  source,           // 'scene' | 'manual'
  stale,            // true if the last Observe failed for this message
  textHash,         // hash of the user message + reply story text it came from
}
```

The current state is the one on the most recent AI message that has it, which
is the message on screen. User messages never hold state.

### Lifecycle

ST keeps a copy of `message.extra` per swipe in `swipe_info[swipe_id].extra`
and restores it on swipe (`syncSwipeToMes` in `script.js`). ST takes that copy
when the reply is saved, which is before Observe runs, so sangkhem writes its
record to both `message.extra.conductor` and
`swipe_info[swipe_id].extra.conductor`. Storing state this way gives most of
the lifecycle for free.

Each record also stores `textHash`, a hash of the user message and the reply's
story text it was extracted from. A record whose hash no longer matches (the
message was edited or rewritten) counts as out of date.

| Event | What happens |
|---|---|
| New reply | Observe runs once the reply settles and writes state to it. |
| Swipe | Each swipe keeps its own state. A new swipe is observed like a new reply. Swiping back restores that swipe's state. |
| Regenerate | Plan uses state from the AI message before the one being replaced. The new reply is observed. |
| Edit AI message | Observe reruns for that message. |
| Edit user message | Observe reruns for the AI reply that follows it, if any. |
| Delete message | State rolls back to the latest remaining AI message that has it. |
| Branch | The branch copies the messages, so it copies their state. |
| Manual edit in panel | Saved with `source: 'manual'`. It is the input to the next Observe, and Observe keeps manual fields unless new evidence changes them. |
| Messages from before install | They have no state. Plan observes the latest AI reply on the first turn (see "Observe timing"). |

### Guarding against the feedback loop

State extracted from the narrator's output goes into the next brief. One bad
extraction ("she's wearing the red coat") would then become a fact the narrator
is told to respect, and the error would reinforce itself. Three defences:

1. **Evidence gate.** The Scene model returns the full new state and an
   `evidence` map. Every field that differs from the previous state must have a
   quote in `evidence`, taken from the new user message or the reply. The
   validator checks each quote is really there (case- and
   whitespace-insensitive substring match). A change without a verified quote
   is reverted to the previous value and listed in the inspector as rejected.
   Unchanged fields need no quote, so the model cannot drift a field silently.
   Evidence keys are field paths: `location`, `time`, `present.<name>` (enters
   or leaves), `present.<name>.<attribute>`, and one quote per thread added or
   closed.
2. **Provenance.** Accepted changes record `{ mesId, quote }` per field path.
   The scene panel shows where each fact came from, and clicking it jumps to
   the message. A wrong fact can be traced and fixed at its source.
3. **Soft framing.** The default brief template labels the block as tracked
   notes and tells the narrator the story text wins if they conflict.

The scene panel's manual edit is the final defence.

## Stages (v1)

### Memory (Plan)

- Backend `summaryception`: available when the extension is installed, enabled,
  and `chatMetadata.summaryception.layers` is an array.
- Reads snippet text the same way Summaryception assembles it: higher layers
  first (last down to 1), then layer 0, joining `sn.text`.
- Parsed defensively. Non-array layers and snippets without string `text` are
  skipped. Any unexpected shape returns `null`, and the stage reports "skipped:
  unreadable store" instead of throwing.
- Output: `{ summary }`. It injects nothing.
- The adapter is the only file that knows Summaryception's storage format.

### Lore (Plan)

A port of Laya WI Director's lore path into a stage.

1. Dry-run World Info scan with ST's own matcher (`checkWorldInfo(chat, contextSize, true)`),
   using the same chat preparation ST uses for the real scan.
2. Constant entries are never judged. With **Protect cache prefix** on, entries
   placed before the chat history (anything not at an `@depth` position) are
   not judged either (see "Brief placement and caching").
3. Up to `maxCandidates` remaining matches go to the scorer. The scoring
   context includes the scene state and the memory summary as well as the last
   `recentTurns` messages, trimmed to fit Laya's 1024-token context.
4. `score = wRelevance * relevance + wUsefulness * usefulness`. Entries are
   ranked and greedily filled into `budgetTokens`. Anything below `minScore` or
   over budget is suppressed.
5. Suppression is applied in memory only, during the real scan, via
   `WORLDINFO_ENTRIES_LOADED`, and cleared on `GENERATION_ENDED` /
   `GENERATION_STOPPED`. Nothing is written to disk.

Kept entries stay at the positions their lorebook authors set. Lore is not
moved into the brief.

Backend `laya` talks to the Laya service (`POST /wi-director`, `GET /health`).
The repo ships a copy at `service/laya/server.py`, with the same endpoints as
the Laya WI Director copy, so either one can serve the default URL
`http://localhost:8666`.

### Brief (Plan)

Renders the scene state into one block. Default template:

```
<scene_notes>
Tracked scene notes. If the story so far says otherwise, the story wins.
Location: Ellen's apartment, kitchen
Time: late evening, raining
Present: Ellen (oversized hoodie; tired; annoyed)
Open threads: owes {{user}} a favor; shark plushie still missing
</scene_notes>
```

- Empty fields are left out. An entirely empty state produces no block.
- The template can be edited in settings.
- Placement is covered below.

### Scene (Observe)

- Input: previous state (including manual edits), the latest user message, the
  new reply's story text, and the character names. Story text is what is
  inside the configured story tags (default `content`) if present, otherwise
  the text outside custom XML tags, so CoT and notes are ignored.
- Calls the configured connection profile with an extraction prompt asking for
  `{ state, evidence }` as JSON.
- Output is parsed, validated against the schema (types, required keys,
  `threads` cap), then passed through the evidence gate.
- On success the state and provenance are written to the message and the chat
  is saved. On failure (unparseable, invalid, timeout) the previous state is
  copied forward with `stale: true`, and the panel shows a warning and a Retry
  button. Bad model output never wipes state.

## Observe timing

Setting `observeTrigger`:

- **`settled` (default).** After `MESSAGE_RECEIVED` or `MESSAGE_EDITED` for an
  AI message, Observe is scheduled `settleMs` later (default 1500). The timer
  restarts on each new event for the same message, so Recast's
  `MESSAGE_EDITED` and ST's `MESSAGE_RECEIVED` produce one call, not two. It is
  cancelled by `MESSAGE_SWIPED`, `MESSAGE_DELETED`, `GENERATION_STARTED` for a
  regenerate or swipe, and `CHAT_CHANGED`, so CoT Guard's auto-swipes and
  quickly rejected replies cost nothing. If the text changes while Observe is
  running, the run is aborted and rescheduled.
- **`commit`.** Nothing runs on arrival. When the user sends the next message,
  Plan observes the latest AI reply first. No calls are spent on discarded
  swipes, but the scene panel lags one turn and extraction time is added before
  the narrator (counted in the Plan budget).

In both modes, Plan checks the latest AI reply. If an Observe for it is running,
Plan waits up to `observeWaitMs` (default 4000). If the reply has no state and
nothing is running (commit mode, messages from before install, earlier failure),
Plan observes it now, within the Plan budget. Otherwise Plan uses the last
completed state.

## Generation types

| Type | Plan | Observe |
|---|---|---|
| normal | runs | runs on the reply |
| swipe / regenerate | runs, with state from the AI message *before* the one being replaced | runs on the new swipe |
| continue | reuses the last brief, no rerun | reruns on the continued message |
| impersonate | runs | does not run (no AI message is produced) |
| quiet | skipped entirely | skipped |

Quiet generations are other extensions' background calls (Summaryception's
summariser and similar). Running on them would waste calls and could loop.

## Brief placement and caching

- **Auto (default).** Injected with
  `setExtensionPrompt('sangkhem', brief, IN_CHAT, 1, false, SYSTEM)`: a system
  message at chat depth 1, directly before the latest user message. Depth can
  be changed in settings.
- **Macro.** `{{conductor_brief}}` is always registered. Preset authors place it
  where they want and switch auto-inject off. The settings panel warns if both
  are used, since the brief would appear twice.

**Why depth 1.** The brief changes every turn. With prompt caching (Claude's
`cachingAtDepth` or a caching proxy), anything that changes invalidates the
cache for everything after it. Placing the brief at depth 1 keeps it after the
long stable prefix (system prompt, character card, top-of-prompt lore, older
history), so that prefix stays cached. A brief near the top would bust it every
turn.

**Ellen Joe preset.** About 60 of its enabled prompts come after the chat
history: output and format rules, the CoT instructions ("CoT Open — Scene &
Intent" and the rest), jailbreaks, and the Fast CoT assistant prefill last. It
also squashes consecutive system messages. Depth 1 puts the brief inside the
chat history, before the latest user message, so the prompt reads: stable
prefix, history with the brief near the end, the post-history instructions,
then the prefill. The brief sits between chat messages, so squashing does not
merge it into the preset's system blocks. The preset needs no change.

Macro mode lets the author put `{{conductor_brief}}` next to "CoT Open — Scene
& Intent", so the CoT reasons over the notes directly. That block is already
after the chat history, outside the cached prefix, so this placement costs
nothing extra in caching.

**Lore pruning and caching.** Pruning World Info placed before the chat history
changes that prefix from turn to turn, which also invalidates the cache. With
caching on, a cache read costs roughly a tenth of a normal input token, so
pruning top-of-prompt lore can cost more than it saves. The Lore stage setting
**Protect cache prefix** (default off) limits judging to `@depth` entries. The
panel suggests turning it on when the active source is Claude with caching
enabled.

## Latency

- The Plan phase has a total budget (`planBudgetMs`, default 8000). When it
  runs out, the remaining Plan stages are skipped and the narrator starts.
- Every stage has its own timeout and receives the generation's abort signal.
- A slow or dead Laya service makes the brief thinner (lore unpruned); it never
  holds up generation.
- Plan stages run one after another. In v1 that costs nothing: Memory is a
  local metadata read (well under a millisecond), and Lore needs its output.
  When a second network-bound Plan stage arrives (the Director), the runner
  will move to dependency-ordered groups that run in parallel.
- The inspector keeps per-stage timings for the session (p50/p95), which
  success criterion 3 is measured against.

## Error handling

Fail-open everywhere: sangkhem never blocks or breaks generation.

- A stage that is unavailable, throws, or times out is skipped and recorded in
  the inspector with the reason. Later stages still run; they see no output
  from the skipped stage.
- A toast appears only after a stage fails `failureToastAfter` times in a row
  (default 3), not every turn.
- `CHAT_CHANGED` aborts in-flight stages and cancels scheduled Observes.
  Results are discarded rather than written to the wrong chat (the chat id is
  checked before any write).

## Setups without the author's tools

sangkhem is installable by URL, so most users will not have Summaryception or a
local Laya service. Each stage checks `available()` and switches itself off
when its dependencies are missing; the settings panel shows each stage's status
and what it needs.

| User has | Working stages |
|---|---|
| Nothing extra | Scene and Brief, once a Scene connection profile is chosen |
| + Summaryception | + Memory (used as Lore context; Summaryception keeps its own injection) |
| + Laya service | + Lore |

The Scene stage has no default connection profile, because silently using the
main API would call the narrator model on every reply. Until a profile is
chosen, the panel shows a notice suggesting a small or free model. With nothing
configured, sangkhem does nothing and ST behaves as normal.

## Settings and UI

Settings live in `extension_settings.sangkhem`.

**Settings panel** (Extensions → sangkhem):

- Master enable.
- Plan budget, observe trigger, settle delay, observe wait.
- Stage status list: available / unavailable (with the reason) / off.
- Per stage: enable, backend or connection profile, timeout.
- Memory: source.
- Lore: service URL, test connection, max candidates, token budget, recent
  turns, relevance and usefulness weights, minimum score, protect cache prefix.
  Conflict warning when applicable.
- Brief: injection mode, depth, template.
- Scene: connection profile, enabled fields, threads cap, story tags.

**Turn inspector**: for the last turn, one row per stage (ran / skipped /
failed, duration, one-line output summary such as "lore: kept 6, dropped 9,
~820 tokens"), rejected scene changes, and brief tokens added. A session
section shows p50/p95 per stage and average tokens added and removed per turn.
It replaces the Laya token HUD and covers every stage.

**Scene panel**: the current state as editable fields, each with its
provenance (message link and quote), plus the stale badge and Retry when
relevant.

**Slash commands**:

- `/conductor on|off|status`
- `/scene` prints the current state
- `/scene set <field>=<value>` edits it by hand (e.g. `/scene set location=rooftop`)

## Testing

Same approach as SnapCompact: `node --test`, no dependencies.

- `src/st.js` wraps `SillyTavern.getContext()` and the few ST imports, so every
  other module is testable in Node with a fake context.
- Unit tests:
  - runner: stage order, per-stage timeout, Plan budget, fail-open on throw,
    unavailable stages skipped, outputs passed forward, abort.
  - backends: every stage runs with the `none` backend in each slot.
  - state: lookup from the latest AI message, swipe and regenerate exclusion,
    stale copy-forward, manual edits kept without new evidence.
  - evidence gate: verified quote accepted, missing or invented quote reverted,
    unchanged fields need no quote, whitespace and case normalisation.
  - schema validation: good JSON, malformed JSON, wrong types, too many threads.
  - observe scheduler: settle debounce, one call for RECEIVED plus EDITED,
    cancel on swipe, delete and chat change, abort and reschedule on text
    change, commit mode.
  - brief rendering: full state, partial, empty, custom template.
  - Summaryception adapter: fixture from a real chat, plus malformed stores.
  - Laya scorer: mocked HTTP service; ranking, budget fill, cache-prefix filter.
  - generation-type rules.
- `tools/eval-scene.mjs` runs fixtures (previous state, user message, reply →
  expected state) against any OpenAI-compatible endpoint and reports per-field
  accuracy and gate rejections. It is used to pick a helper model before
  trusting it (success criterion 1).
- A manual checklist in a real ST install covers every generation type,
  Recast on, CoT Guard auto-swipes, chat switching mid-turn, service down, the
  Laya conflict check, and a vanilla install with nothing extra.

## Repo layout

```
manifest.json            loading_order: 200, generate_interceptor: conductorInterceptor
index.js                 wires stages, events, UI
settings.html
style.css
src/
  st.js                  ST context wrapper
  runner.js              phase runner: order, timeouts, budget, fail-open
  state.js               lookup, save, schema validation
  evidence.js            evidence gate and provenance
  observe.js             observe scheduler (settle, cancel, commit mode)
  llm.js                 connection-profile calls
  commands.js            slash commands
  stages/
    memory.js
    lore.js
    brief.js
    scene.js
  backends/
    memory/summaryception.js
    memory/none.js
    scorers/laya.js
    scorers/none.js
  ui/
    settings.js
    inspector.js
    scenePanel.js
service/laya/server.py   Laya service (copied from Laya WI Director)
tools/eval-scene.mjs
tests/
docs/superpowers/specs/
```

## Open risks

- **Scene extraction quality** from small models is the biggest unknown. The
  eval tool measures it before anyone relies on it, the schema is small, and
  the evidence gate limits the damage of a bad extraction.
- **The evidence gate may be too strict.** Small models may paraphrase instead
  of quoting, so real changes get rejected. The eval tool reports rejections so
  this can be tuned (for example by allowing a fuzzy match) with data.
- **Summaryception format changes** would break the Memory adapter. It is
  isolated, parsed defensively, and fails open.
- **Laya's 1024-token context** limits how much scene and summary context the
  Lore scorer can use. The context is trimmed to fit.
- **Load order is by convention.** Another extension with `loading_order`
  above 200 that rewrites replies would run after Observe starts. The settle
  delay and abort-and-reschedule on text change cover this, at the cost of one
  extra call.
