# sangkhem — handoff (2026-09-26)

State of the project after v1 was built, reviewed, tested inside SillyTavern and merged into `main`.
Read this before changing anything. It covers what exists, how it fits together, what has been
verified and what hasn't, the one open bug, every deferred issue, and the conventions to keep.

- Repo: `/Users/westin/Desktop/sangkhem` → `github.com/soliloquy1/sangkhem` (nothing pushed yet)
- Spec (binding authority): `docs/superpowers/specs/2026-09-25-conductor-design.md`
- Plan (as-built; its code blocks match the repo): `docs/superpowers/plans/2026-09-25-conductor-v1.md`
- User docs: `README.md`, manual checklist: `docs/manual-test.md`

---

## 1. What sangkhem is

A SillyTavern (1.16.0) extension that runs small helper stages around the user's narrator model,
instead of relying on one big model and one big prompt. Inspired by a r/SillyTavern comment: nobody
will train a trillion-parameter RP model, so the realistic path is layered orchestration of small
helpers feeding a frontier narrator.

Each generation has two phases:

```
user sends (ST appends the user message FIRST, then runs extension interceptors)
  │
  ▼  PLAN — globalThis.conductorInterceptor (index.js) → conductor.plan()
  │    0. catch-up: observe any un-extracted replies of the latest AI run (≤4, oldest first),
  │       wait up to observeWaitMs (default 4000) for the last one; Stop aborts the wait
  │    1. Memory  — read Summaryception's summary (context for Lore only; never re-injected)
  │    2. Lore    — dry-run WI scan, Laya scores entries, drop low-value ones for this turn only
  │    3. Brief   — render <scene_notes> and inject it (IN_CHAT, depth 1, system role)
  ▼
narrator writes (user's preset, untouched)
  │
  ▼  OBSERVE — after the reply settles (settleMs 1500) or at next send (commit mode)
       4. Scene — helper LLM (a connection profile) returns {state, evidence}; each change needs a
          verbatim quote from the user message or reply; record stored on the message + active swipe
```

Fail-open everywhere: a missing/failed/slow stage is skipped; generation always proceeds.

## 2. Code map (≈2200 lines of JS, 187 tests)

Only `index.js`, `src/st.js`, `src/commands.js` and `src/ui/{dom,panel,settingsForm,scenePanel,inspector}.js`
may touch `SillyTavern`/`document`/`window`/`toastr`/`jQuery`. Everything else is plain Node-testable
logic; `tests/imports.test.js` enforces this.

| File | Responsibility |
|---|---|
| `index.js` | Builds stages + conductor, sets `globalThis.conductorInterceptor`, wires ST events (all wrapped by `safe()`), registers macro/commands, mounts panel |
| `manifest.json` | `loading_order: 200` (after Recast=9, SnapCompact=60, others=100), `generate_interceptor: conductorInterceptor` |
| `src/settings.js` | `MODULE_NAME='sangkhem'`, `DEFAULTS`, `mergeDefaults`, `getPath/setPath` |
| `src/runner.js` | `runPhase` (order, per-stage timeout, phase budget, `budgetExempt`, budget-clipped timeout = skip), `describeStage`, `FailureTracker` |
| `src/state.js` | Scene schema + `validateState`, `readState`, `writeRecord` (message + swipe_info copy), `hashText` (FNV-1a), `isFresh`, `/scene set` parsing, `applyFieldEdit` |
| `src/evidence.js` | `normalize` (NFKC, quotes incl. 「」『』, no `*_`), quote specificity (2 words / 3 CJK-Thai chars), `diffPaths`, `applyEvidenceGate` (incl. thread cap) |
| `src/story.js` | `extractStory` — story tags (`content`) or strip custom-tagged blocks (CoT, trackers) |
| `src/llm.js` | `createLlm`, `parseJsonReply` |
| `src/observe.js` | `ObserveScheduler` — settle debounce, cancel, abort-on-text-change, one job at a time in start order, `flush` |
| `src/stats.js` | Session p50/p95 and token averages |
| `src/conductor.js` | Orchestration: `plan`, `observe`, `catchUpIndices`, `observeInput`, all event handlers, `currentView`, `setState`, `editField`, `retry`, `statusText` |
| `src/stages/{memory,lore,brief,scene}.js` | The four stages |
| `src/backends/resolve.js` | `resolveBackend` (falls back to `none`), `BackendUnavailableError` |
| `src/backends/memory/{summaryception,none}.js` | Summaryception store reader (only file that knows its format) |
| `src/backends/scorers/{laya,none}.js` | Laya HTTP scorer; unavailable until `/health` answers once; 60 s down-cache |
| `src/st.js` | ST adapter (settings, chat, prompt injection, WI dry-run scan, connection-profile requests, macro, profiles) |
| `src/commands.js` | `/conductor on|off|status`, `/scene`, `/scene set <path>=<value>` |
| `src/ui/*` | `h()` (textContent-only builder), formatters, draft merge (`applyDraftChanges`), settings form, scene panel, inspector, panel |
| `service/laya/` | Laya Python service, byte-identical copy of Laya WI Director's |
| `tools/eval-scene.mjs`, `tools/eval-score.mjs`, `tools/fixtures/scene/` | Scene-extraction eval: change recall + stability |

### Key invariants (don't break these)
- **Fail-open**: interceptor and every event handler catch everything; `runPhase` never throws.
- **Never render chat/model text as HTML**: use `h()` / `textContent`. Only static `settings.html` uses `innerHTML`.
- **Records**: `message.extra.conductor = { state, provenance, source: 'scene'|'manual', stale, textHash, updatedAt }`,
  also written to `message.swipe_info[swipe_id].extra.conductor` (ST snapshots extra before Observe runs).
- **Freshness**: a record is current iff `record.textHash === hashText(userText + '\n' + replyStoryText)`.
- **Hand edits win**: `setState` cancels in-flight observes, stamps the current hash, refuses drafts from another
  chat/message/swipe; `observe()` discards its result if the record changed while it ran; a failed observe keeps
  the message's own manual record labelled `manual`.
- **Discard stale results**: `observe()` returns without writing if aborted, chat id changed, message object
  changed, or text hash changed.
- **ST event order** (verified in `public/script.js`): user message appended (`:4288`) → interceptors (`:4394`);
  regenerate deletes the old reply before interceptors (`:4245`); swipe keeps it in `chat` but pops it from
  `coreChat` (`:4333`). `catchUpIndices` steps over trailing non-AI messages because of this.

## 3. Verification status

- `npm test`: **187/187 pass** (Node ≥ 20; no dependencies).
- Every task passed a spec + quality review; a final whole-branch Opus review found C1/I1/I2, all fixed and
  re-reviewed clean.
- **Verified inside the user's SillyTavern** (temporary chats; main API never called): loads with no console
  errors; stage statuses/reasons; Observe end to end with a real model (quotes, provenance, stale + Retry);
  brief injection (IN_CHAT depth 1 system) and `{{conductor_brief}}`; `/conductor`, `/scene`, dotted names;
  `<img onerror>` stays literal; CHAT_CHANGED clears the brief; commit-mode catch-up in ST's real event order,
  background completion, next plan uses the result; Lore "checking" → "unreachable" without the service.
- **Then used by the user in a real chat** ("The Popular Girls Hidden Life"): Observe works (7 changes
  accepted/0 rejected, ~10 s per extraction with their model); surfaced the open bug below.
- **Not verified**: where the brief lands in a real prompt itemization with the Ellen Joe preset; Summaryception
  memory feeding Lore (Memory itself was seen running: "Summaryception, 2406 chars"); Laya scoring (service not
  running); the eval tool against a real model (no API key available to the CLI); the spec's success criteria
  (eval ≥ 90% recall/stability, 50-turn continuity A/B, p95 latency).

### Testing techniques that worked in ST (built-in browser, `http://127.0.0.1:8000`)
- `/tempchat` (never saved), `/sendas name=X text` (AI message without generating), `/send text`
  (user message without generating), then `await globalThis.conductorInterceptor(chat.filter(m=>!m.is_system).map(m=>({...m})), 8000, ()=>{}, 'normal')`
  to run Plan in the real order.
- **Pitfall**: ST replaces the `extension_prompts` object on chat change — always read
  `SillyTavern.getContext().extensionPrompts` fresh; a context captured earlier shows stale values.
- Restore any sangkhem setting you change; check `data/default-user/settings.json` afterwards.

## 4. OPEN BUG — the narrator copies the scene notes into its reply

**Symptom** (user screenshot, 2026-09-26): the reply ends with a "Tracked scene notes. … Location: … Present: …
Open threads: …" block visible in the chat.

**Evidence** (`data/default-user/chats/The Popular Girls Hidden Life/…2026-09-25@15h09m30s404ms.jsonl`,
message index 28, swipe 2/2): the stored `mes` (7677 chars) contains `<scene_notes>…</scene_notes>` starting
at char 7010, i.e. **the narrator model wrote it** at the end of its reply. The content is richer than
sangkhem's format (e.g. `Miyuki (seated, book closed on armrest, asked twice now…)`), so the model imitated the
injected block rather than echoing it verbatim. ST hides the unknown tags but shows their text.
sangkhem itself did not write into the message (its record there is a normal `source: 'scene'`), and its own
extraction ignores the block (`extractStory` strips custom-tagged blocks).

**Why it probably happens**
- The brief is a system message at depth 1, formatted like a tracker block, right before the latest user
  message; the Ellen Joe preset has "Hidden/Utility Trackers" / status-block conventions after the chat history,
  so the model treats `<scene_notes>` as an output format to continue.
- Once one reply contains the block, it stays in chat history and the model sees its own previous
  "tracker" output, reinforcing the habit every turn.

**Fix options (not implemented; decide before building)**
1. **Strip echoed blocks from replies** — on `MESSAGE_RECEIVED` / `MESSAGE_UPDATED` (and for swipes), remove
   `<scene_notes>…</scene_notes>` (plus an unclosed trailing one) from `message.mes` and the active
   `swipes[]` entry, then `updateMessageBlock` + save. Removes it from display *and* from history (breaks the
   feedback loop). Must run before Observe hashes the text (or Observe will re-run once — acceptable) and must
   coexist with Recast (loading_order 9) and CoT Guard. A ST Regex-extension script is an alternative, but
   code keeps it self-contained. Needs tests with fixtures shaped like message 28.
2. **Make the block less imitable** — change the template: say explicitly "Private notes for you; never write
   them, or anything like them, in your reply"; consider a different wrapper (e.g. `[OOC scene notes — do not
   reproduce]`) or `role: user`/assistant-prefill-safe placement; keep the tag distinct from preset tracker tags.
3. **Macro mode by default for CoT presets** — putting `{{conductor_brief}}` inside the preset's CoT
   instructions (e.g. next to "CoT Open — Scene & Intent") makes it planning input rather than a chat message.
4. **Clean existing history** — offer a one-off `/scene clean` (or do it in option 1) to strip already-echoed
   blocks from the current chat.

**Recommendation**: 1 + 2 together (strip as the safety net, reword to stop the habit), with a test pinning
message-28-shaped input. Verify in ST with the user's Ellen Joe preset and their narrator model.

## 5. Deferred issues (all non-blocking; triaged by the final reviewer)

Behaviour / UX
- Panel doesn't refresh when the background Laya probe finishes — Stages shows "checking" until the next refresh.
- Typing in the Laya URL field fires a few sequential `/health` probes (one per keystroke save).
- Stopped/superseded plans still record `lastPlan` and stats (all-skipped reports).
- A failed observe stamps the current text hash, so it isn't retried automatically (documented in README).
- `FailureTracker` streaks carry across chat changes.
- Dirty scene draft is dropped silently on chat/message/swipe change (no toast); `onSave` has no try/catch;
  `setState` validation warnings (threads over cap, dropped people) aren't shown.
- Settings number inputs accept negatives / ignore `min`/`max`; no Memory/Brief timeout inputs (spec asks
  "per stage: timeout").
- Profile `<select>` refills on focus (may jump on mobile).
- Double-brief warning only checks chat-completion prompts (not text-completion story string/instruct).
- `/conductor status` toast uses `escapeHtml: false` (safe today: only ids/statuses) — build from escaped lines.
- Narrator messages from `/sys` (`is_user:false, is_system:false`) count as AI replies for catch-up/readState.
- Lore dry-run scan passes ST's default `globalScanData` (no card/persona fields, no generation type):
  type-limited entries can be judged/charged on turns they won't activate. Build it from
  `getCharacterCardFields()` and pass `type`.
- `stripTagged` pair regex is case-sensitive: `<Thinking>…</thinking>` falls to the unclosed-tag rule.
- Legacy `registerMacro` logs a `[DEPRECATED]` warning on load; if the user flips the new macro engine
  *off* mid-session, `{{conductor_brief}}` needs a reload.
- The evidence gate proves a quote exists, not that it supports the change (seen: `time: "Cold wind"`).
  Duplicate threads aren't detected ("What Hana confessed…" vs "Hana's confession…").

Code hygiene
- Several exports lack JSDoc (state.js `isAiMessage`/`isFresh`, evidence.js `quoteIsSpecific`/`verifyQuote`,
  scene.js `enabledFields`/`buildScenePrompt`, brief.js `renderSceneLine`, st.js/commands.js/ui exports);
  `stats.js` percentile JSDoc says "sorted array" though input needn't be.
- `mergeDefaults` copies unknown saved keys by reference.
- `applyEvidenceGate` re-diffs inline instead of reusing `diffPaths`.
- `buildScenePrompt` calls `replyText.trim()` unguarded (its only caller guards it).
- `src/evidence.js` lacks a trailing newline; `tests/evidence.test.js` has stray blank lines.
- Some conductor tests use `sleep(40)` vs `settleMs: 10` (possible CI flake).
- `imports.test.js` regex `\b(document|window)\b` can false-positive on comment words.
- `currentSource()` reads `chat_completion_source` even under text completion (only used by the cache hint).

## 6. The user's environment (as of 2026-09-26)

- SillyTavern 1.16.0 at `/Users/westin/SillyTavern-Launcher/SillyTavern`, running on `127.0.0.1:8000`
  (whitelist mode, no basic auth). **sangkhem is installed as a symlink**:
  `data/default-user/extensions/sangkhem → /Users/westin/Desktop/sangkhem` (remove with `rm` to uninstall).
- Main API: Chat Completion, `custom` source via the user's local proxy `http://localhost:20128/v1`
  (model at last check `agy/claude-opus-4-6-thinking`); preset family "Ellen Joe" (≈59 enabled prompts after
  chat history, CoT prompts, Fast CoT assistant prefill, squash system messages).
- **Scene profile that works**: `custom agy/gemini-3.1-pro-low` (same proxy), ~10 s per extraction.
  OpenRouter (`stepfun/step-3.5-flash:free`) and Routeway (`deepseek-r1-distill-qwen-32b:free`) profiles return
  **"Unauthorized"** — ST sends the currently active key for the source, so only profiles on the same
  endpoint authenticate. LM Studio Gemma profile needs LM Studio running (`:1234`).
- Extensions of note: Summaryception (on), SnapCompact, Recast, Ellen Joe CoT Guard, Laya WI Director
  (installed, its Enable **off** — keep it off or sangkhem's Lore stands down), qvink/Megumin/JS-Slash-Runner disabled.
- `power_user.experimental_macro_engine: true` (new macro engine on).
- Laya service not running; start with `service/laya/README.md`.
- User settings in use: default settled mode. Suggested: "Wait for scene tracking" ≈ 12000 given ~10 s extractions.

## 7. Rulings made during the build (with cost if wrong)

1. Symlinked sangkhem into the user's ST for testing — removable with `rm`.
2. All in-ST checks done by the controller at the end in temporary chats — ST-only bugs surfaced in one batch.
3. Kept extra JSDoc an implementer added to `stats.js` — comments only.
4. Task 12: hand edits stamped with the current text hash; drafts refused if chat/message/swipe changed.
5. Task 13: `{{conductor_brief}}` registered in the legacy (default) macro engine and the new one.
6. Task 14: saving a draft applies only the user's edited paths onto the latest state; Save with no edits is a no-op.
7. Parked: "race between `applyDraftChanges` and `setState`" — cannot occur (no await between them).
8. Left sangkhem installed and enabled (inert without a scene profile / Laya).
9. Final C1: catch-up steps over the just-appended user message (ST order).
10. Final I1: a stale copy of a message's own hand edit stays `manual` so Retry builds on it.
11. Final I2: Laya is unavailable until a `/health` probe succeeds; URL change re-checks.

## 8. Future work (from the spec, unchanged)

Director stage (plot/pacing), narrator tool calls (`recall_memory`, `check_state`, `lookup_lore` via
`registerFunctionTool`), reply guard as an Observe stage, more memory sources (qvink), more lore scorers
(Jev, any LLM via profile), fallback memory without a summary extension, post-processing stages, parallel
stage groups, automated continuity A/B harness, SnapCompact opt-in integration, fine-tuned helpers.

## 9. Conventions

- **No `Co-Authored-By` or any attribution trailer** in commits or PRs (user rule).
- No npm dependencies; `npm test` = `node --test`; Node ≥ 20.
- Style: 4-space indent, single quotes, semicolons, ES modules, JSDoc on exports; match surrounding code.
- Process used: brainstorm → spec → plan (code blocks extracted and tested before execution) →
  subagent-driven execution with per-task review → final review → in-ST verification. Keep the plan's code
  blocks in sync with the repo if the plan is reused.
- Never push without the user asking.
