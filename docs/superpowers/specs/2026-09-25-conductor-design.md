# sangkhem — Conductor design (v1)

Date: 2026-09-25
Status: approved in brainstorming, awaiting spec review

## Goal

Make roleplay in SillyTavern better by coordinating several small, specialised
helpers around one frontier "narrator" model, instead of relying on one large
model and one large prompt.

The idea comes from a SillyTavern community comment: nobody is going to train a
trillion-parameter RP model, so the realistic path is layered orchestration —
small systems for embedding, recall, classification and direction, handing off
to a frontier model for the final narration.

sangkhem is that orchestration layer, shipped as a SillyTavern extension.

## Background: what already exists

The author's SillyTavern install (1.16.0) already has most of the individual
parts. None of them coordinate; each hooks generation on its own.

| Layer | Existing piece | Notes |
|---|---|---|
| Recall / memory | Summaryception (third party) | Stores layered summaries in `chatMetadata.summaryception`, injects them itself |
| Recall / memory | SnapCompact (author's) | Sends the Summaryception summary as images to save tokens |
| Classification | Laya WI Director (author's) | Local Laya model scores keyword-matched World Info entries, prunes low-value ones |
| Classification | jev-use (author's fork) | Experience with Jev as a pick-from-options decision model |
| Narration | Frontier models via custom proxy + Ellen Joe preset | CoT Guard enforces the preset's CoT tags |
| Post-processing | Recast (third party) | Multi-pass rewrite of replies |
| Direction | — | Nothing directs plot, pacing or scenes |
| Scene state | — | Nothing tracks location, outfits, who is present |

The missing piece is the conductor: shared state and one place that runs the
helpers in order and hands the narrator a clean brief.

## Scope

### v1 includes

- A standalone SillyTavern extension (this repo), installable by URL.
- A stage pipeline with two phases (Plan, Observe).
- Four stages: Memory, Lore, Brief (Plan) and Scene (Observe).
- Pluggable backends: one memory source (Summaryception), one lore scorer (Laya).
- Per-message scene state, a brief injected into the prompt, settings, a turn
  inspector, a scene panel and slash commands.
- A scene-extraction eval tool.

### v1 does not include (future work, same interface)

- Director stage (plot threads, pacing, next-beat suggestions).
- Narrator tool calls (`recall_memory`, `check_state`, `lookup_lore`) via
  `registerFunctionTool`.
- Reply guard as an Observe stage (port of Laya WI Director's `/reply-guard`
  and `/echo-check`). Until then the standalone extension's guard keeps working.
- More memory sources (qvink MessageSummarize, others).
- More lore scorers (Jev, any LLM via connection profile).
- Built-in fallback memory for users without a summary extension.
- Post-processing stages.
- Fine-tuned helper models.

## Architecture

### Turn flow

```
 user sends message
        │
        ▼
 ┌─ PLAN phase (generate_interceptor, before narrator) ──────────┐
 │  load scene state                                             │
 │  run plan stages in order:  Memory ─▶ Lore ─▶ Brief           │
 │  inject brief                                                 │
 └───────────────────────────────────────────────────────────────┘
        │
        ▼
 narrator (frontier model, user's preset) writes reply
        │
        ▼
 ┌─ OBSERVE phase (MESSAGE_RECEIVED, after reply, async) ────────┐
 │  run observe stages:  Scene                                   │
 │  save new state onto that message                             │
 └───────────────────────────────────────────────────────────────┘
```

Plan runs before the narrator, so it adds latency; it stays light. Observe runs
after the reply is on screen, while the user reads and types, so it adds none.
Heavier work (small-model extraction) belongs in Observe.

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

- `turn` carries: the chat array, the generation type, an `AbortSignal`, and
  `outputs` — a map of earlier stages' `output` keyed by stage id (e.g. Lore
  reads `turn.outputs.memory.summary`).
- `state` is the current scene state (read-only for Plan stages in v1).
- `config` is the stage's own settings slice.
- Stages run sequentially in registration order within a phase.

### Pluggable backends

Stages that talk to external systems do so through small adapters so new ones
can be added without touching the stage:

- **Memory source**: `{ id, available(ctx), getSummary(ctx) → string | null }`.
  v1: `summaryception`.
- **Lore scorer**: `{ id, available(ctx), async score(candidates, context, signal) → [{ uid, world, relevance, usefulness }] }`.
  v1: `laya`.
- **LLM calls** (used by Scene, and later by others) go through
  `ConnectionManagerRequestService.sendRequest(profileId, …)`, so each stage can
  use any saved connection profile — local LM Studio, a free OpenRouter model,
  or a paid API. This is how per-layer cost and latency are made configurable.

## Scene state

### Schema (v1)

Kept deliberately small so a small model can produce it reliably.

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
- Fields can be switched off in settings; disabled fields are omitted from the
  extraction prompt and the brief.

### Storage

State is stored on each AI message at `message.extra.conductor`:

```js
message.extra.conductor = {
  state,            // the schema above
  updatedAt,        // ISO timestamp
  source,           // 'scene' | 'manual'
  stale,            // true if the last Observe failed for this message
}
```

The current state is the one on the most recent AI message that has it, which
is the message on screen. Because ST syncs `message.extra` into
`swipe_info[swipe_id].extra` and restores it on swipe (`syncSwipeToMes`,
`script.js`), this gives, with no extra bookkeeping:

- deleting a message rolls state back;
- each swipe has its own state;
- branches carry state with them.

User messages never hold state. The Observe pass for an AI reply reads the new
user message and the reply together, so actions described by the user are
captured.

### Editing

- Editing an AI message (`MESSAGE_EDITED`) reruns Observe for that message.
  Editing a user message reruns Observe for the AI reply that follows it, if
  there is one.
- The scene panel lets the user edit state by hand. Manual edits are saved with
  `source: 'manual'` and take precedence until the next Observe on a newer
  message.

## Stages (v1)

### Memory (Plan)

- Backend `summaryception`: available when the extension is installed, enabled,
  and `chatMetadata.summaryception.layers` exists.
- Reads snippet text the same way Summaryception assembles it: higher layers
  first (last to 1), then layer 0; joins `sn.text`.
- Output: `{ summary }`. It does **not** inject anything — Summaryception keeps
  doing its own injection, so nothing is doubled.
- The adapter is the only file that knows Summaryception's storage format.

### Lore (Plan)

A port of Laya WI Director's lore path into a stage.

1. Dry-run World Info scan with ST's own matcher (`checkWorldInfo(chat, contextSize, true)`),
   using the same chat preparation ST uses for the real scan.
2. Constant entries are never judged.
3. Up to `maxCandidates` non-constant matches are sent to the scorer. The
   scoring context now includes the scene state and the memory summary, not only
   the last `recentTurns` messages.
4. `score = wRelevance * relevance + wUsefulness * usefulness`; entries are
   ranked, greedily filled into `budgetTokens`, and anything below `minScore`
   or over budget is suppressed.
5. Suppression is applied in memory only, during the real scan, via
   `WORLDINFO_ENTRIES_LOADED`, and cleared on `GENERATION_ENDED` /
   `GENERATION_STOPPED`. Nothing is written to disk.

Kept entries stay at the positions their lorebook authors set. Lore is not
moved into the brief.

Backend `laya` talks to the Laya service (`POST /wi-director`, `GET /health`).
The repo ships a copy of the service at `service/laya/server.py`; it exposes the
same endpoints as the Laya WI Director copy, so either one can be running on the
default URL `http://localhost:8666`.

**Conflict check:** if the standalone Laya WI Director extension is enabled and
its director setting (`extension_settings.laya_wi_director.enabled`) is on, the
Lore stage disables itself and the settings panel shows a warning, so lore is
never pruned twice. The standalone extension's reply guard (`guardEnabled`) is
unaffected and may keep running against the same service.

### Brief (Plan)

Renders the scene state into one block:

```
<scene>
Location: Ellen's apartment, kitchen
Time: late evening, raining
Present: Ellen (oversized hoodie; tired; annoyed)
Open threads: owes {{user}} a favor; shark plushie still missing
</scene>
```

- Empty fields are omitted; an entirely empty state produces no block.
- The template is editable in settings.
- Two injection modes:
  - **Auto (default)**: `setExtensionPrompt('sangkhem', brief, IN_CHAT, depth, false, SYSTEM)`,
    depth configurable (default 1). Works with any preset unchanged.
  - **Macro**: registers `{{conductor_brief}}`; preset authors place it where
    they want and turn auto-inject off.
- The macro is always registered, so it resolves even in Auto mode. Settings
  warn that using both will duplicate the brief.

### Scene (Observe)

- Triggered on `MESSAGE_RECEIVED` for AI messages (not quiet, not
  impersonate), and on `MESSAGE_EDITED`.
- Input: previous state, the latest user message, the new reply (story text
  only — content inside configured story tags if present, otherwise text
  outside custom XML tags, so CoT is ignored), and the character names.
- Calls the configured connection profile with an extraction prompt that asks
  for the full new state as JSON.
- Output is parsed and validated against the schema (types, required keys,
  `threads` cap). On success the state is written to the message and saved. On
  failure the previous state is copied forward with `stale: true`, the panel
  shows a warning and a Retry button. Bad model output never wipes state.

## Generation types

| Type | Plan | Observe |
|---|---|---|
| normal | runs | runs on the reply |
| swipe / regenerate | runs, with state from the AI message *before* the one being replaced | runs on the new swipe |
| continue | reuses the last brief, no rerun | runs again on the continued message |
| impersonate | runs | does not run |
| quiet | skipped entirely | skipped |

Quiet generations are other extensions' background calls (Summaryception's
summariser, etc.). Running on them would waste calls and could loop.

If a previous Observe is still running when Plan starts, Plan waits for it up to
`observeWaitMs` (default 4000) and otherwise uses the last completed state.

## Error handling

Fail-open everywhere: sangkhem never blocks or breaks generation.

- Every stage runs with its own timeout (configurable per stage) and the
  generation's abort signal.
- A stage that is unavailable, throws, or times out is skipped and recorded in
  the inspector with the reason. Later stages still run; they see no output from
  the skipped stage.
- The Plan phase has a total budget (`planBudgetMs`, default 8000). When it is
  exceeded, remaining Plan stages are skipped and the narrator starts.
- A toast appears only after a stage fails `failureToastAfter` times in a row
  (default 3), not on every turn.
- `CHAT_CHANGED` aborts in-flight stages; results are discarded rather than
  written to the wrong chat (checked by comparing chat id before writing).

## Settings and UI

Settings live in `extension_settings.sangkhem`.

**Settings panel** (Extensions → sangkhem):

- Master enable.
- Plan budget, observe wait.
- Per stage: enable, backend / connection profile, timeout.
- Memory: source (v1: Summaryception).
- Lore: service URL, test connection, max candidates, token budget, recent
  turns, relevance/usefulness weights, minimum score. Conflict warning when
  applicable.
- Brief: injection mode, depth, template.
- Scene: connection profile, enabled fields, threads cap, story tags.

**Turn inspector**: for the last turn, one row per stage — ran / skipped /
failed, duration, and a one-line output summary (e.g. "lore: kept 6, dropped 9,
~820 tokens"). Replaces the Laya token HUD and covers every stage.

**Scene panel**: shows the current state as editable fields, with the stale
badge and Retry when relevant.

**Slash commands**:

- `/conductor on|off|status`
- `/scene` — print current state
- `/scene set <field>=<value>` — manual edit (e.g. `/scene set location=rooftop`)

## Testing

Same approach as SnapCompact: `node --test`, no dependencies.

- `src/st.js` wraps `SillyTavern.getContext()` and the few ST imports, so all
  other modules are testable in Node with a fake context.
- Unit tests:
  - runner: stage order, per-stage timeout, plan budget, fail-open on throw,
    unavailable stages skipped, outputs passed forward, abort.
  - state: lookup from latest AI message, swipe/regenerate exclusion, stale
    copy-forward, manual precedence.
  - schema validation: good JSON, malformed JSON, wrong types, over-cap threads.
  - brief rendering: full state, partial, empty, custom template.
  - Summaryception adapter against a fixture taken from a real chat's metadata.
  - Laya scorer against a mocked HTTP service; lore ranking and budget fill.
  - generation-type rules.
- `tools/eval-scene.mjs`: runs a fixture set of (previous state, user message,
  reply → expected state) against any OpenAI-compatible endpoint and reports
  per-field accuracy. Used to pick a helper model before trusting it.
- Manual checklist in a real ST install covering every generation type, chat
  switching mid-turn, service down, and the Laya conflict check.

## Repo layout

```
manifest.json            generate_interceptor: conductorInterceptor
index.js                 wires stages, events, UI
settings.html
style.css
src/
  st.js                  ST context wrapper
  runner.js              phase runner: order, timeouts, budget, fail-open
  state.js               lookup, save, validation, schema
  llm.js                 connection-profile calls
  commands.js            slash commands
  stages/
    memory.js
    lore.js
    brief.js
    scene.js
  backends/
    memory/summaryception.js
    scorers/laya.js
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
  eval tool exists to measure it before relying on it; the schema is kept small
  for the same reason.
- **Summaryception format changes** would break the Memory adapter. The adapter
  is isolated and fails open.
- **Laya's 1024-token context** limits how much scene/summary context the Lore
  scorer can use; the context passed to it must be trimmed to fit.
