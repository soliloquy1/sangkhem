# sangkhem Conductor v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a SillyTavern extension that runs small helper stages around the narrator model: Memory, Lore and Brief before each reply (Plan), and Scene state extraction after it (Observe).

**Architecture:** A phase runner executes stage objects in order with per-stage timeouts, a Plan budget and fail-open handling. A conductor module wires SillyTavern events to the runner and keeps scene state on each AI message (`message.extra.conductor`, mirrored into the active swipe). All logic lives in plain ES modules testable in Node; only `src/st.js`, `src/commands.js`, `src/ui/*` and `index.js` touch SillyTavern or the DOM.

**Tech Stack:** Browser ES modules (SillyTavern 1.16 extension API), Node ≥ 20 built-in test runner (`node --test`, `node:assert/strict`), no npm dependencies. Python Laya service copied unchanged from Laya WI Director.

**Spec:** `docs/superpowers/specs/2026-09-25-conductor-design.md`

## Global Constraints

- SillyTavern ≥ 1.16.0. Uses `ConnectionManagerRequestService`, `setExtensionPrompt`, `WORLDINFO_ENTRIES_LOADED`, `macros.register` (falls back to `registerMacro`).
- Tests: `npm test` runs `node --test`. Node ≥ 20. No npm dependencies, ever.
- Only `index.js`, `src/st.js`, `src/commands.js` and `src/ui/dom.js`, `src/ui/panel.js`, `src/ui/settingsForm.js`, `src/ui/scenePanel.js`, `src/ui/inspector.js` may reference `SillyTavern`, `document`, `window`, `toastr` or `jQuery`. Every other module must import cleanly in plain Node (enforced by `tests/imports.test.js`).
- Names: module/settings key `sangkhem` (`extension_settings.sangkhem`); message record `message.extra.conductor`; extension prompt key `sangkhem`; macro `{{conductor_brief}}`; interceptor `globalThis.conductorInterceptor`; manifest `loading_order: 200`.
- Defaults, verbatim from the spec: `planBudgetMs` 8000, `observeWaitMs` 4000, `settleMs` 1500, `failureToastAfter` 3, threads cap 8, brief depth 1, story tags `content`, Laya URL `http://localhost:8666`, `maxCandidates` 25, `budgetTokens` 1024, `recentTurns` 4, `wRelevance` 1.0, `wUsefulness` 1.0, `minScore` 1.0, `protectCachePrefix` false. Added in plan review: scene `temperature` 0, `CATCH_UP_LIMIT` 4.
- Fail-open: nothing may throw out of the interceptor or an event handler. A failing stage is skipped; generation always proceeds.
- The Brief stage is budget-exempt: running out of plan budget (for example waiting on scene tracking) must never cost the narrator its scene notes.
- Manual scene edits always win over an extraction that was already running.
- Toasts that include error text pass `{ escapeHtml: true }`.
- Never put chat or model text into `innerHTML`. Build DOM with `h()` from `src/ui/dom.js` (textContent only).
- Commit messages have no Co-Authored-By or other attribution trailer.
- Code style: 4-space indent, single quotes, semicolons, ES modules, JSDoc on exported functions — same as SnapCompact.

## Review Focus

1. **Model output containing markup** (`"location": "<img src=x onerror=alert(1)>"`) must render as literal text in the scene panel and inspector. Pinned by the `h()` test in Task 14.
2. **Group chats / consecutive AI messages** (two character replies with no user message between): Observe must read an empty user message, not an older one. Pinned in Task 3 (`previousUserIndex`) and Task 12 (`observeInput`).
3. **Non-English replies** (Chinese, Japanese, corner-bracket quotes 「」, full-width punctuation quoted back as ASCII, e.g. `走吧，她说` quoted as `走吧,她说`) must pass the evidence gate when the quote is really there. Pinned in Task 4.
4. **Character names with dots or spaces** (`/scene set present.Dr. Kim.outfit=lab coat`) must parse to name `Dr. Kim`, attribute `outfit`. Pinned in Task 3.
5. **Message deleted, swiped or chat switched while Observe is running**: the late result must be discarded, never written onto the wrong message or chat. Pinned in Task 12.

---

## File structure

```
package.json                   test script, Node engine
manifest.json                  ST manifest (loading_order 200, interceptor)
index.js                       wires stages, conductor, events, UI, commands
settings.html                  settings drawer markup
style.css                      panel styles
src/
  settings.js                  MODULE_NAME, DEFAULTS, mergeDefaults, getPath/setPath
  runner.js                    runPhase, runWithTimeout, describeStage, FailureTracker
  state.js                     schema, validation, lookup, records, hashing, manual edits
  evidence.js                  diffPaths, evidence gate, provenance
  story.js                     story-text extraction (strip CoT/custom tags)
  llm.js                       createLlm, parseJsonReply
  observe.js                   ObserveScheduler (settle, cancel, flush)
  stats.js                     session timing and token stats
  conductor.js                 plan/observe orchestration, event handlers, manual edits
  st.js                        the SillyTavern adapter
  commands.js                  /conductor, /scene
  backends/
    resolve.js                 resolveBackend, BackendUnavailableError
    memory/summaryception.js   reads chatMetadata.summaryception
    memory/none.js
    scorers/laya.js            Laya HTTP scorer with down-cache
    scorers/none.js
  stages/
    memory.js
    lore.js                    candidate selection, ranking, suppression
    brief.js                   render + inject
    scene.js                   prompt, parse, validate, gate
  ui/
    dom.js                     h() element builder (textContent only)
    format.js                  pure text formatting for the panel
    settingsForm.js            data-sk-setting binding, profiles, Laya test
    scenePanel.js              editable state + provenance
    inspector.js               last turn + session stats
    panel.js                   mounts everything, refreshPanel()
service/laya/                  server.py, requirements.txt (copied), README.md
tools/
  eval-scene.mjs               runs fixtures against an OpenAI-compatible endpoint
  eval-score.mjs               pure scoring helpers
  fixtures/scene/*.json
tests/                         one *.test.js per module, plus fixtures/
docs/manual-test.md            real-ST checklist
README.md
```

---

### Task 1: Scaffold and settings

**Files:**
- Create: `package.json`, `manifest.json`, `.gitignore`, `src/settings.js`
- Test: `tests/settings.test.js`

**Interfaces:**
- Produces: `MODULE_NAME = 'sangkhem'`, `LOG_PREFIX = '[sangkhem]'`, `DEFAULT_BRIEF_TEMPLATE`, `DEFAULTS`, `mergeDefaults(saved, defaults = DEFAULTS) → settings`, `getPath(obj, path) → any`, `setPath(obj, path, value) → void`.

- [ ] **Step 1: Create project files**

`package.json`:
```json
{
    "name": "sangkhem",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "description": "SillyTavern extension: a conductor that runs small helper stages around your narrator model.",
    "license": "MIT",
    "scripts": {
        "test": "node --test"
    },
    "engines": {
        "node": ">=20"
    }
}
```

`manifest.json`:
```json
{
    "display_name": "sangkhem",
    "loading_order": 200,
    "requires": [],
    "optional": [],
    "js": "index.js",
    "css": "style.css",
    "author": "soliloquy1",
    "version": "0.1.0",
    "homePage": "https://github.com/soliloquy1/sangkhem",
    "auto_update": false,
    "generate_interceptor": "conductorInterceptor"
}
```

`.gitignore`:
```
node_modules/
.DS_Store
service/laya/.venv/
service/laya/__pycache__/
```

- [ ] **Step 2: Write the failing test**

`tests/settings.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, mergeDefaults, getPath, setPath } from '../src/settings.js';

test('mergeDefaults returns a fresh copy of the defaults for empty input', () => {
    const a = mergeDefaults(undefined);
    const b = mergeDefaults(null);
    assert.deepEqual(a, DEFAULTS);
    assert.deepEqual(b, DEFAULTS);
    a.stages.lore.maxCandidates = 3;
    assert.equal(DEFAULTS.stages.lore.maxCandidates, 25);
});

test('mergeDefaults keeps saved values of the right type and fills missing keys', () => {
    const merged = mergeDefaults({ planBudgetMs: 5000, stages: { lore: { serviceUrl: 'http://x:1' } } });
    assert.equal(merged.planBudgetMs, 5000);
    assert.equal(merged.stages.lore.serviceUrl, 'http://x:1');
    assert.equal(merged.stages.lore.maxCandidates, 25);
    assert.equal(merged.stages.scene.threadsCap, 8);
});

test('mergeDefaults ignores saved values of the wrong type', () => {
    const merged = mergeDefaults({ planBudgetMs: 'fast', stages: 'broken' });
    assert.equal(merged.planBudgetMs, 8000);
    assert.deepEqual(merged.stages, DEFAULTS.stages);
});

test('mergeDefaults keeps unknown keys for forward compatibility', () => {
    assert.equal(mergeDefaults({ futureThing: 1 }).futureThing, 1);
});

test('defaults match the spec', () => {
    assert.equal(DEFAULTS.enabled, true);
    assert.equal(DEFAULTS.planBudgetMs, 8000);
    assert.equal(DEFAULTS.observeTrigger, 'settled');
    assert.equal(DEFAULTS.settleMs, 1500);
    assert.equal(DEFAULTS.observeWaitMs, 4000);
    assert.equal(DEFAULTS.failureToastAfter, 3);
    const { memory, lore, brief, scene } = DEFAULTS.stages;
    assert.equal(memory.backend, 'summaryception');
    assert.deepEqual(
        [lore.backend, lore.serviceUrl, lore.maxCandidates, lore.budgetTokens, lore.recentTurns, lore.wRelevance, lore.wUsefulness, lore.minScore, lore.protectCachePrefix],
        ['laya', 'http://localhost:8666', 25, 1024, 4, 1, 1, 1, false],
    );
    assert.deepEqual([brief.mode, brief.depth], ['auto', 1]);
    assert.ok(brief.template.includes('{{scene}}'));
    assert.deepEqual([scene.profileId, scene.threadsCap, scene.storyTags, scene.temperature], ['', 8, 'content', 0]);
    assert.equal('includeNames' in lore, false);
    assert.deepEqual(scene.fields, { location: true, time: true, present: true, threads: true });
});

test('getPath and setPath walk dotted paths', () => {
    const obj = { a: { b: 1 } };
    assert.equal(getPath(obj, 'a.b'), 1);
    assert.equal(getPath(obj, 'a.c.d'), undefined);
    setPath(obj, 'a.c.d', 2);
    assert.equal(obj.a.c.d, 2);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, `Cannot find module .../src/settings.js`

- [ ] **Step 4: Write the implementation**

`src/settings.js`:
```js
export const MODULE_NAME = 'sangkhem';
export const LOG_PREFIX = '[sangkhem]';

export const DEFAULT_BRIEF_TEMPLATE = [
    '<scene_notes>',
    'Tracked scene notes. If the story so far says otherwise, the story wins.',
    '{{scene}}',
    '</scene_notes>',
].join('\n');

export const DEFAULTS = {
    enabled: true,
    planBudgetMs: 8000,
    observeTrigger: 'settled', // 'settled' | 'commit'
    settleMs: 1500,
    observeWaitMs: 4000,
    failureToastAfter: 3,
    stages: {
        memory: {
            enabled: true,
            backend: 'summaryception',
            timeoutMs: 500,
        },
        lore: {
            enabled: true,
            backend: 'laya',
            timeoutMs: 5000,
            serviceUrl: 'http://localhost:8666',
            maxCandidates: 25,
            budgetTokens: 1024,
            recentTurns: 4,
            wRelevance: 1,
            wUsefulness: 1,
            minScore: 1,
            protectCachePrefix: false,
        },
        brief: {
            enabled: true,
            mode: 'auto', // 'auto' | 'macro'
            depth: 1,
            template: DEFAULT_BRIEF_TEMPLATE,
            timeoutMs: 500,
        },
        scene: {
            enabled: true,
            profileId: '',
            timeoutMs: 20000,
            maxTokens: 800,
            temperature: 0, // pinned so the eval tool measures the same settings as the extension
            threadsCap: 8,
            storyTags: 'content',
            fields: { location: true, time: true, present: true, threads: true },
        },
    },
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Deep-merges saved settings over the defaults. Saved values of the wrong type are ignored;
 * unknown saved keys are kept.
 * @param {any} saved
 * @param {object} [defaults]
 * @returns {object}
 */
export function mergeDefaults(saved, defaults = DEFAULTS) {
    const out = structuredClone(defaults);
    if (!isPlainObject(saved)) return out;
    for (const [key, value] of Object.entries(saved)) {
        if (!(key in out)) {
            out[key] = value;
        } else if (isPlainObject(out[key])) {
            if (isPlainObject(value)) out[key] = mergeDefaults(value, out[key]);
        } else if (typeof value === typeof out[key]) {
            out[key] = value;
        }
    }
    return out;
}

/** @param {object} obj @param {string} path dotted path */
export function getPath(obj, path) {
    return path.split('.').reduce((node, key) => node?.[key], obj);
}

/** @param {object} obj @param {string} path dotted path @param {any} value */
export function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let node = obj;
    for (const key of keys) node = node[key] ??= {};
    node[last] = value;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json manifest.json .gitignore src/settings.js tests/settings.test.js
git commit -m "feat: scaffold extension and settings defaults"
```

---

### Task 2: Phase runner and backend resolution

**Files:**
- Create: `src/runner.js`, `src/backends/resolve.js`
- Test: `tests/runner.test.js`, `tests/resolve.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Stage shape: `{ id: string, phase: 'plan'|'observe', budgetExempt?: boolean, available?(ctx, config) → true|string, run(turn, state, config) → Promise<StageResult|void> }`. A `budgetExempt` stage runs even after the phase budget is used up, with its own timeout. A timeout that the budget shortened is reported as `skipped` (`plan budget used up`), not `failed`. `StageResult = { statePatch?: object, output?: any, skip?: string, summary?: string }`.
  - `runPhase(stages, { phase, turn, state, settings, budgetMs = Infinity, now = Date.now }) → Promise<{ outputs, state, reports }>`. Each stage receives `{ ...turn, outputs, signal }` where `signal` aborts on timeout or on `turn.signal`. `reports[]` items: `{ id, status: 'ran'|'skipped'|'failed'|'off', ms, reason?, summary? }`.
  - `runWithTimeout(task: (signal) => Promise, ms, parentSignal?) → Promise`; `StageTimeoutError`, `StageAbortedError`.
  - `describeStage(stage, settings, ctx) → { id, status: 'off'|'ready'|'unavailable', reason? }`.
  - `class FailureTracker { record(reports, threshold) → string[] }` (stage ids that just hit `threshold` consecutive failures).
  - `DEFAULT_STAGE_TIMEOUT_MS = 10000`.
  - `resolveBackend(backends, id, ctx) → { backend, reason: string|null }` (falls back to `backends.none`); `class BackendUnavailableError extends Error`.

- [ ] **Step 1: Write the failing tests**

`tests/runner.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPhase, runWithTimeout, describeStage, FailureTracker, StageTimeoutError } from '../src/runner.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stage = (id, run, extra = {}) => ({ id, phase: 'plan', run, ...extra });
const settings = (stages = {}) => ({ stages });

test('runs stages of the phase in order and passes outputs forward', async () => {
    const seen = [];
    const stages = [
        stage('a', async () => { seen.push('a'); return { output: 1 }; }),
        { id: 'x', phase: 'observe', run: async () => { seen.push('x'); } },
        stage('b', async (turn) => { seen.push(`b:${turn.outputs.a}`); return { output: 2, summary: 'ok' }; }),
    ];
    const result = await runPhase(stages, { phase: 'plan', turn: {}, state: {}, settings: settings() });
    assert.deepEqual(seen, ['a', 'b:1']);
    assert.deepEqual(result.outputs, { a: 1, b: 2 });
    assert.deepEqual(result.reports.map((r) => [r.id, r.status, r.summary]), [['a', 'ran', undefined], ['b', 'ran', 'ok']]);
});

test('statePatch is merged and seen by later stages', async () => {
    const stages = [
        stage('a', async () => ({ statePatch: { location: 'roof' } })),
        stage('b', async (_turn, state) => ({ output: state.location })),
    ];
    const result = await runPhase(stages, { phase: 'plan', turn: {}, state: { location: '', time: 'noon' }, settings: settings() });
    assert.deepEqual(result.state, { location: 'roof', time: 'noon' });
    assert.equal(result.outputs.b, 'roof');
});

test('disabled stages are reported off and not run', async () => {
    let ran = false;
    const result = await runPhase([stage('a', async () => { ran = true; })], {
        phase: 'plan', turn: {}, state: {}, settings: settings({ a: { enabled: false } }),
    });
    assert.equal(ran, false);
    assert.equal(result.reports[0].status, 'off');
});

test('unavailable stages are skipped with the reason', async () => {
    const result = await runPhase([stage('a', async () => {}, { available: () => 'no service' })], {
        phase: 'plan', turn: {}, state: {}, settings: settings(),
    });
    assert.deepEqual([result.reports[0].status, result.reports[0].reason], ['skipped', 'no service']);
});

test('a stage returning skip is reported skipped and its output is not stored', async () => {
    const result = await runPhase([stage('a', async () => ({ skip: 'nothing to do', output: 5 }))], {
        phase: 'plan', turn: {}, state: {}, settings: settings(),
    });
    assert.equal(result.reports[0].status, 'skipped');
    assert.equal('a' in result.outputs, false);
});

test('a throwing stage fails open and later stages still run', async () => {
    const result = await runPhase([
        stage('a', async () => { throw new Error('boom'); }),
        stage('b', async () => ({ output: 'fine' })),
    ], { phase: 'plan', turn: {}, state: {}, settings: settings() });
    assert.deepEqual(result.reports.map((r) => r.status), ['failed', 'ran']);
    assert.equal(result.reports[0].reason, 'boom');
    assert.equal(result.outputs.b, 'fine');
});

test('a stage that exceeds its timeout fails and its signal is aborted', async () => {
    let innerSignal;
    const result = await runPhase([stage('a', async (turn) => { innerSignal = turn.signal; await sleep(200); })], {
        phase: 'plan', turn: {}, state: {}, settings: settings({ a: { timeoutMs: 20 } }),
    });
    assert.equal(result.reports[0].status, 'failed');
    assert.match(result.reports[0].reason, /timed out after 20 ms/);
    assert.equal(innerSignal.aborted, true);
});

test('the phase budget skips remaining stages once used up', async () => {
    let clock = 0;
    const now = () => clock;
    const result = await runPhase([
        stage('a', async () => { clock += 100; }),
        stage('b', async () => ({ output: 1 })),
    ], { phase: 'plan', turn: {}, state: {}, settings: settings(), budgetMs: 50, now });
    assert.deepEqual(result.reports.map((r) => r.status), ['ran', 'skipped']);
    assert.equal(result.reports[1].reason, 'plan budget used up');
});

test('a budget-exempt stage still runs after the budget is used up', async () => {
    let clock = 0;
    const result = await runPhase([
        stage('a', async () => { clock += 100; }),
        stage('brief', async () => ({ output: 'notes' }), { budgetExempt: true }),
    ], { phase: 'plan', turn: {}, state: {}, settings: settings(), budgetMs: 50, now: () => clock });
    assert.deepEqual(result.reports.map((r) => r.status), ['ran', 'ran']);
    assert.equal(result.outputs.brief, 'notes');
});

test('a timeout cut short by the budget is a skip, not a failure', async () => {
    const result = await runPhase([stage('lore', () => sleep(200))], {
        phase: 'plan', turn: {}, state: {}, settings: settings({ lore: { timeoutMs: 5000 } }), budgetMs: 20,
    });
    assert.deepEqual([result.reports[0].status, result.reports[0].reason], ['skipped', 'plan budget used up']);
});

test('an aborted parent signal skips stages and does not count as failure', async () => {
    const controller = new AbortController();
    const result = await runPhase([
        stage('a', async () => { controller.abort(); await sleep(50); }),
        stage('b', async () => {}),
    ], { phase: 'plan', turn: { signal: controller.signal }, state: {}, settings: settings() });
    assert.deepEqual(result.reports.map((r) => [r.status, r.reason]), [['skipped', 'aborted'], ['skipped', 'aborted']]);
});

test('runWithTimeout resolves, rejects on timeout, and catches sync throws', async () => {
    assert.equal(await runWithTimeout(async () => 7, 100), 7);
    await assert.rejects(runWithTimeout(() => sleep(100), 10), StageTimeoutError);
    await assert.rejects(runWithTimeout(() => { throw new Error('sync'); }, 100), /sync/);
});

test('describeStage reports off, ready and unavailable', () => {
    const s = stage('a', async () => {}, { available: (_ctx, config) => (config.url ? true : 'set a URL') });
    assert.deepEqual(describeStage(s, settings({ a: { enabled: false } }), {}), { id: 'a', status: 'off' });
    assert.deepEqual(describeStage(s, settings({ a: { url: 'x' } }), {}), { id: 'a', status: 'ready' });
    assert.deepEqual(describeStage(s, settings({ a: {} }), {}), { id: 'a', status: 'unavailable', reason: 'set a URL' });
});

test('FailureTracker alerts once when a stage reaches the threshold', () => {
    const tracker = new FailureTracker();
    const fail = [{ id: 'lore', status: 'failed' }];
    assert.deepEqual(tracker.record(fail, 3), []);
    assert.deepEqual(tracker.record(fail, 3), []);
    assert.deepEqual(tracker.record(fail, 3), ['lore']);
    assert.deepEqual(tracker.record(fail, 3), []);
    tracker.record([{ id: 'lore', status: 'ran' }], 3);
    tracker.record(fail, 3);
    tracker.record(fail, 3);
    assert.deepEqual(tracker.record(fail, 3), ['lore']);
});

test('FailureTracker ignores skipped stages', () => {
    const tracker = new FailureTracker();
    tracker.record([{ id: 'lore', status: 'failed' }], 2);
    tracker.record([{ id: 'lore', status: 'skipped' }], 2);
    assert.deepEqual(tracker.record([{ id: 'lore', status: 'failed' }], 2), ['lore']);
});
```

`tests/resolve.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackend } from '../src/backends/resolve.js';

const none = { id: 'none', available: () => true };
const real = (availability) => ({ id: 'real', available: () => availability });

test('returns the chosen backend when available', () => {
    const backend = real(true);
    assert.deepEqual(resolveBackend({ real: backend, none }, 'real', {}), { backend, reason: null });
});

test('falls back to none with the reason when unavailable', () => {
    assert.deepEqual(resolveBackend({ real: real('not installed'), none }, 'real', {}), { backend: none, reason: 'not installed' });
    assert.deepEqual(resolveBackend({ real: real(false), none }, 'real', {}), { backend: none, reason: 'real unavailable' });
});

test('falls back to none for unknown ids', () => {
    assert.deepEqual(resolveBackend({ none }, 'jev', {}), { backend: none, reason: 'unknown backend "jev"' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, modules `src/runner.js` and `src/backends/resolve.js` not found.

- [ ] **Step 3: Write the implementation**

`src/runner.js`:
```js
export const DEFAULT_STAGE_TIMEOUT_MS = 10000;

export class StageTimeoutError extends Error {
    constructor(ms) {
        super(`timed out after ${ms} ms`);
        this.name = 'StageTimeoutError';
    }
}

export class StageAbortedError extends Error {
    constructor() {
        super('aborted');
        this.name = 'StageAbortedError';
    }
}

/**
 * Runs task(signal) with a timeout. The signal aborts on timeout or when parentSignal aborts.
 * @param {(signal: AbortSignal) => any} task
 * @param {number} ms
 * @param {AbortSignal} [parentSignal]
 */
export function runWithTimeout(task, ms, parentSignal) {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let timer = null;
        const cleanup = () => {
            if (timer !== null) clearTimeout(timer);
            parentSignal?.removeEventListener('abort', onParentAbort);
        };
        function onParentAbort() {
            controller.abort();
            cleanup();
            reject(new StageAbortedError());
        }
        if (parentSignal?.aborted) {
            reject(new StageAbortedError());
            return;
        }
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });
        if (Number.isFinite(ms)) {
            timer = setTimeout(() => {
                controller.abort();
                cleanup();
                reject(new StageTimeoutError(ms));
            }, ms);
        }
        Promise.resolve()
            .then(() => task(controller.signal))
            .then(
                (value) => { cleanup(); resolve(value); },
                (error) => { cleanup(); reject(error); },
            );
    });
}

function availability(stage, ctx, config) {
    try {
        return stage.available ? stage.available(ctx, config) : true;
    } catch (error) {
        return `availability check failed: ${error.message}`;
    }
}

/**
 * Status of a stage for the settings panel.
 * @returns {{ id: string, status: 'off'|'ready'|'unavailable', reason?: string }}
 */
export function describeStage(stage, settings, ctx) {
    const config = settings?.stages?.[stage.id] ?? {};
    if (config.enabled === false) return { id: stage.id, status: 'off' };
    const result = availability(stage, ctx, config);
    if (result === true) return { id: stage.id, status: 'ready' };
    return { id: stage.id, status: 'unavailable', reason: typeof result === 'string' ? result : 'unavailable' };
}

/**
 * Runs every stage of one phase in order. Never throws: failures become reports.
 * A stage with `budgetExempt: true` still runs after the budget is used up (cheap stages only).
 * @returns {Promise<{ outputs: object, state: object, reports: object[] }>}
 */
export async function runPhase(stages, { phase, turn, state, settings, budgetMs = Infinity, now = Date.now }) {
    const started = now();
    const outputs = {};
    const reports = [];
    let current = state;
    for (const stage of stages.filter((s) => s.phase === phase)) {
        const config = settings?.stages?.[stage.id] ?? {};
        const skip = (reason, ms = 0) => reports.push({ id: stage.id, status: 'skipped', ms, reason });
        if (config.enabled === false) {
            reports.push({ id: stage.id, status: 'off', ms: 0 });
            continue;
        }
        if (turn.signal?.aborted) {
            skip('aborted');
            continue;
        }
        const remaining = budgetMs - (now() - started);
        const exempt = stage.budgetExempt === true;
        if (remaining <= 0 && !exempt) {
            skip('plan budget used up');
            continue;
        }
        const available = availability(stage, turn.ctx, config);
        if (available !== true) {
            skip(typeof available === 'string' ? available : 'unavailable');
            continue;
        }
        const ownTimeout = config.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
        // A timeout shortened by the budget is the budget's fault, not the stage's: report a skip.
        const clipped = !exempt && remaining < ownTimeout;
        const timeoutMs = exempt ? ownTimeout : Math.min(ownTimeout, remaining);
        const t0 = now();
        try {
            const result = (await runWithTimeout(
                (signal) => stage.run({ ...turn, outputs, signal }, current, config),
                timeoutMs,
                turn.signal,
            )) ?? {};
            const ms = now() - t0;
            if (result.skip) {
                skip(result.skip, ms);
                continue;
            }
            if ('output' in result) outputs[stage.id] = result.output;
            if (result.statePatch) current = { ...current, ...result.statePatch };
            reports.push({ id: stage.id, status: 'ran', ms, summary: result.summary });
        } catch (error) {
            if (error instanceof StageAbortedError) skip('aborted', now() - t0);
            else if (error instanceof StageTimeoutError && clipped) skip('plan budget used up', now() - t0);
            else reports.push({ id: stage.id, status: 'failed', ms: now() - t0, reason: error?.message ?? String(error) });
        }
    }
    return { outputs, state: current, reports };
}

/** Counts consecutive failures per stage so the UI can warn once, not every turn. */
export class FailureTracker {
    constructor() {
        this.streaks = new Map();
    }

    /** @returns {string[]} ids of stages whose failure streak just reached threshold */
    record(reports, threshold) {
        const alerts = [];
        for (const { id, status } of reports) {
            if (status === 'failed') {
                const count = (this.streaks.get(id) ?? 0) + 1;
                this.streaks.set(id, count);
                if (count === threshold) alerts.push(id);
            } else if (status === 'ran') {
                this.streaks.set(id, 0);
            }
        }
        return alerts;
    }
}
```

`src/backends/resolve.js`:
```js
/** Thrown by a backend whose service cannot be reached; stages turn it into a skip, not a failure. */
export class BackendUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BackendUnavailableError';
    }
}

/**
 * Picks the configured backend, or `backends.none` when it is unknown or unavailable.
 * @returns {{ backend: object, reason: string|null }}
 */
export function resolveBackend(backends, id, ctx) {
    const chosen = backends[id];
    if (!chosen) return { backend: backends.none, reason: `unknown backend "${id}"` };
    const availability = chosen.available(ctx);
    if (availability === true) return { backend: chosen, reason: null };
    return { backend: backends.none, reason: typeof availability === 'string' ? availability : `${id} unavailable` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all runner, resolve and settings tests).

- [ ] **Step 5: Commit**

```bash
git add src/runner.js src/backends/resolve.js tests/runner.test.js tests/resolve.test.js
git commit -m "feat: add fail-open phase runner and backend resolution"
```

---

### Task 3: Scene state model

**Files:**
- Create: `src/state.js`
- Test: `tests/state.test.js`

**Interfaces:**
- Produces:
  - `SCHEMA_VERSION = 1`, `PERSON_ATTRS = ['outfit', 'condition', 'mood']`, `FIELDS = ['location', 'time', 'present', 'threads']`.
  - `emptyState() → State` where `State = { v, location, time, present: [{ name, outfit, condition, mood }], threads: string[] }`.
  - `validateState(raw, { threadsCap = 8 }) → { ok: true, state, warnings: string[] } | { ok: false, error }`.
  - `isAiMessage(message) → boolean`, `latestAiIndex(chat, before = chat.length) → number`, `previousUserIndex(chat, index) → number`.
  - `readState(chat, { before = chat.length }) → { state, record, index }` (validated; `emptyState()`/`null`/`-1` when none).
  - `makeRecord({ state, provenance = {}, source, stale = false, textHash = null, now }) → Record`.
  - `writeRecord(message, record)` writes `message.extra.conductor` and `message.swipe_info[swipe_id].extra.conductor`.
  - `hashText(text) → string` (FNV-1a, 8 hex chars), `isFresh(record, textHash) → boolean`.
  - `parseSceneSet(arg) → { path, value } | null`, `applyFieldEdit(state, path, value) → { ok: true, state } | { ok: false, error }`.

- [ ] **Step 1: Write the failing test**

`tests/state.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    emptyState, validateState, isAiMessage, latestAiIndex, previousUserIndex, readState,
    makeRecord, writeRecord, hashText, isFresh, parseSceneSet, applyFieldEdit,
} from '../src/state.js';

const user = (mes) => ({ is_user: true, mes });
const ai = (mes, conductor) => ({ is_user: false, mes, extra: conductor ? { conductor } : {} });
const sys = (mes) => ({ is_user: false, is_system: true, mes });
const good = { location: 'kitchen', time: 'night', present: [{ name: 'Ellen', outfit: 'hoodie' }], threads: ['owes a favor'] };

test('validateState fills defaults and trims', () => {
    const result = validateState({ location: '  kitchen ', present: [{ name: 'Ellen' }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.state, {
        v: 1, location: 'kitchen', time: '', present: [{ name: 'Ellen', outfit: '', condition: '', mood: '' }], threads: [],
    });
});

test('validateState rejects wrong types', () => {
    assert.equal(validateState(null).ok, false);
    assert.equal(validateState([]).ok, false);
    assert.match(validateState({ location: 5 }).error, /location/);
    assert.match(validateState({ present: 'Ellen' }).error, /present/);
    assert.match(validateState({ present: [{ name: 'Ellen', mood: {} }] }).error, /mood/);
    assert.match(validateState({ threads: [1] }).error, /threads/);
});

test('validateState drops nameless and duplicate people with warnings', () => {
    const result = validateState({ present: [{ outfit: 'x' }, { name: 'Ellen' }, { name: 'ellen' }] });
    assert.deepEqual(result.state.present.map((p) => p.name), ['Ellen']);
    assert.equal(result.warnings.length, 2);
});

test('validateState dedupes threads and keeps the first threadsCap', () => {
    const result = validateState({ threads: ['a', 'A', 'b', 'c', ''] }, { threadsCap: 2 });
    assert.deepEqual(result.state.threads, ['a', 'b']);
    assert.match(result.warnings[0], /kept the first 2 of 3 threads/);
});

test('message helpers', () => {
    const chat = [ai('greeting'), user('hi'), sys('note'), ai('reply')];
    assert.equal(isAiMessage(chat[0]), true);
    assert.equal(isAiMessage(chat[2]), false);
    assert.equal(latestAiIndex(chat), 3);
    assert.equal(latestAiIndex(chat, 3), 0);
    assert.equal(latestAiIndex([]), -1);
    assert.equal(previousUserIndex(chat, 3), 1);
});

test('previousUserIndex stops at an earlier AI message (group chats)', () => {
    const chat = [user('hi'), ai('Ellen replies'), ai('Lycaon replies')];
    assert.equal(previousUserIndex(chat, 2), -1);
    assert.equal(previousUserIndex(chat, 1), 0);
});

test('readState finds the latest AI message with a valid record', () => {
    const chat = [
        ai('a', { state: { ...good, location: 'old' } }),
        user('u'),
        ai('b', { state: { location: 7 } }),
        ai('c'),
    ];
    const found = readState(chat);
    assert.equal(found.index, 0);
    assert.equal(found.state.location, 'old');
    assert.deepEqual(readState(chat, { before: 0 }), { state: emptyState(), record: null, index: -1 });
});

test('readState ignores records on user messages', () => {
    const chat = [{ is_user: true, mes: 'x', extra: { conductor: { state: good } } }];
    assert.equal(readState(chat).index, -1);
});

test('writeRecord writes the message and its active swipe', () => {
    const message = { mes: 'x', swipe_id: 1, swipe_info: [{ extra: {} }, { extra: { other: 1 } }] };
    const record = makeRecord({ state: emptyState(), source: 'scene', textHash: 'abc', now: () => 'T' });
    writeRecord(message, record);
    assert.deepEqual(message.extra.conductor, { state: emptyState(), provenance: {}, source: 'scene', stale: false, textHash: 'abc', updatedAt: 'T' });
    assert.deepEqual(message.swipe_info[1].extra.conductor, message.extra.conductor);
    assert.notEqual(message.swipe_info[1].extra.conductor, message.extra.conductor);
    assert.equal(message.swipe_info[1].extra.other, 1);
    assert.equal(message.swipe_info[0].extra.conductor, undefined);
});

test('writeRecord works on messages without swipes', () => {
    const message = { mes: 'x' };
    writeRecord(message, makeRecord({ state: emptyState(), source: 'scene' }));
    assert.equal(message.extra.conductor.source, 'scene');
});

test('hashText is stable and isFresh compares hashes', () => {
    assert.equal(hashText('abc'), hashText('abc'));
    assert.notEqual(hashText('abc'), hashText('abd'));
    assert.match(hashText(''), /^[0-9a-f]{8}$/);
    assert.equal(isFresh({ state: {}, textHash: 'h' }, 'h'), true);
    assert.equal(isFresh({ state: {}, textHash: 'h' }, 'x'), false);
    assert.equal(isFresh(undefined, 'h'), false);
});

test('parseSceneSet splits on the first =', () => {
    assert.deepEqual(parseSceneSet('location=roof = top'), { path: 'location', value: 'roof = top' });
    assert.deepEqual(parseSceneSet('  present.Ellen.outfit = coat '), { path: 'present.Ellen.outfit', value: 'coat' });
    assert.equal(parseSceneSet('location'), null);
    assert.equal(parseSceneSet('=x'), null);
});

test('applyFieldEdit sets simple fields and threads', () => {
    const state = validateState(good).state;
    assert.equal(applyFieldEdit(state, 'location', 'roof').state.location, 'roof');
    assert.deepEqual(applyFieldEdit(state, 'threads', 'a; b ;').state.threads, ['a', 'b']);
    assert.equal(state.location, 'kitchen');
});

test('applyFieldEdit sets attributes, adding the person if needed, and removes people', () => {
    const state = validateState(good).state;
    const added = applyFieldEdit(state, 'present.Lycaon.mood', 'calm').state;
    assert.deepEqual(added.present[1], { name: 'Lycaon', outfit: '', condition: '', mood: 'calm' });
    const changed = applyFieldEdit(state, 'present.ellen.outfit', 'coat').state;
    assert.equal(changed.present[0].outfit, 'coat');
    const removed = applyFieldEdit(state, 'present.Ellen', '').state;
    assert.deepEqual(removed.present, []);
});

test('applyFieldEdit handles names with dots and spaces', () => {
    const edited = applyFieldEdit(emptyState(), 'present.Dr. Kim.outfit', 'lab coat');
    assert.deepEqual(edited.state.present, [{ name: 'Dr. Kim', outfit: 'lab coat', condition: '', mood: '' }]);
    const parsed = parseSceneSet('present.Dr. Kim.outfit=lab coat');
    assert.deepEqual(parsed, { path: 'present.Dr. Kim.outfit', value: 'lab coat' });
});

test('applyFieldEdit rejects unknown paths', () => {
    assert.equal(applyFieldEdit(emptyState(), 'weather', 'rain').ok, false);
    assert.equal(applyFieldEdit(emptyState(), 'present.', 'x').ok, false);
    assert.equal(applyFieldEdit(emptyState(), 'present.Ellen', 'here').ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/state.test.js`
Expected: FAIL, `src/state.js` not found.

- [ ] **Step 3: Write the implementation**

`src/state.js`:
```js
export const SCHEMA_VERSION = 1;
export const PERSON_ATTRS = ['outfit', 'condition', 'mood'];
export const FIELDS = ['location', 'time', 'present', 'threads'];

/** @returns {{ v: number, location: string, time: string, present: object[], threads: string[] }} */
export function emptyState() {
    return { v: SCHEMA_VERSION, location: '', time: '', present: [], threads: [] };
}

// String fields: trimmed string, '' for missing, null for a wrong type.
const asString = (value) => (typeof value === 'string' ? value.trim() : value == null ? '' : null);
const key = (text) => text.trim().toLowerCase();

/**
 * Checks and normalises a scene state from a model or a chat file.
 * @returns {{ ok: true, state: object, warnings: string[] } | { ok: false, error: string }}
 */
export function validateState(raw, { threadsCap = 8 } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'state is not an object' };
    const warnings = [];
    const state = emptyState();
    for (const field of ['location', 'time']) {
        const value = asString(raw[field]);
        if (value === null) return { ok: false, error: `${field} is not a string` };
        state[field] = value;
    }

    const present = raw.present ?? [];
    if (!Array.isArray(present)) return { ok: false, error: 'present is not an array' };
    const names = new Set();
    for (const person of present) {
        if (!person || typeof person !== 'object') return { ok: false, error: 'present has an entry that is not an object' };
        const name = asString(person.name);
        if (!name) {
            warnings.push('dropped a present entry with no name');
            continue;
        }
        if (names.has(key(name))) {
            warnings.push(`dropped duplicate present entry "${name}"`);
            continue;
        }
        names.add(key(name));
        const entry = { name };
        for (const attr of PERSON_ATTRS) {
            const value = asString(person[attr]);
            if (value === null) return { ok: false, error: `present.${name}.${attr} is not a string` };
            entry[attr] = value;
        }
        state.present.push(entry);
    }

    const threads = raw.threads ?? [];
    if (!Array.isArray(threads)) return { ok: false, error: 'threads is not an array' };
    const seen = new Set();
    for (const thread of threads) {
        const value = asString(thread);
        if (value === null) return { ok: false, error: 'threads has an entry that is not a string' };
        if (!value || seen.has(key(value))) continue;
        seen.add(key(value));
        state.threads.push(value);
    }
    if (state.threads.length > threadsCap) {
        warnings.push(`kept the first ${threadsCap} of ${state.threads.length} threads`);
        state.threads = state.threads.slice(0, threadsCap);
    }
    return { ok: true, state, warnings };
}

export const isAiMessage = (message) => Boolean(message) && !message.is_user && !message.is_system;

/** Index of the latest AI message before `before`, or -1. */
export function latestAiIndex(chat, before = chat.length) {
    for (let i = Math.min(before, chat.length) - 1; i >= 0; i--) {
        if (isAiMessage(chat[i])) return i;
    }
    return -1;
}

/** Index of the user message directly answered by chat[index], or -1 (e.g. consecutive group replies). */
export function previousUserIndex(chat, index) {
    for (let i = index - 1; i >= 0; i--) {
        if (chat[i]?.is_user) return i;
        if (isAiMessage(chat[i])) return -1;
    }
    return -1;
}

/**
 * Scene state from the latest AI message before `before` that holds a valid record.
 * @returns {{ state: object, record: object|null, index: number }}
 */
export function readState(chat, { before = chat.length } = {}) {
    for (let i = Math.min(before, chat.length) - 1; i >= 0; i--) {
        const record = chat[i]?.extra?.conductor;
        if (!isAiMessage(chat[i]) || !record?.state) continue;
        const checked = validateState(record.state, { threadsCap: Infinity });
        if (checked.ok) return { state: checked.state, record, index: i };
    }
    return { state: emptyState(), record: null, index: -1 };
}

export function makeRecord({ state, provenance = {}, source, stale = false, textHash = null, now = () => new Date().toISOString() }) {
    return { state, provenance, source, stale, textHash, updatedAt: now() };
}

/**
 * Stores a record on the message and on its active swipe. ST snapshots message.extra into
 * swipe_info when the reply is saved, which is before Observe finishes, so both are written.
 */
export function writeRecord(message, record) {
    message.extra ??= {};
    message.extra.conductor = record;
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[message.swipe_id ?? 0] : null;
    if (info && typeof info === 'object') {
        info.extra ??= {};
        info.extra.conductor = structuredClone(record);
    }
}

/** FNV-1a 32-bit hash as 8 hex characters. */
export function hashText(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export const isFresh = (record, textHash) => Boolean(record?.state) && record.textHash === textHash;

/** "path=value" → { path, value }, or null. */
export function parseSceneSet(arg) {
    const text = String(arg ?? '');
    const at = text.indexOf('=');
    if (at <= 0) return null;
    const path = text.slice(0, at).trim();
    if (!path) return null;
    return { path, value: text.slice(at + 1).trim() };
}

function parsePresentPath(rest) {
    for (const attr of PERSON_ATTRS) {
        if (rest.toLowerCase().endsWith(`.${attr}`)) return { name: rest.slice(0, -(attr.length + 1)).trim(), attr };
    }
    return { name: rest.trim(), attr: null };
}

/**
 * Applies one manual edit. Paths: location, time, threads ("a; b"), present.<Name>.<attr>=value
 * (adds the person if missing), present.<Name>= (empty value removes the person).
 */
export function applyFieldEdit(state, path, value) {
    const next = structuredClone(state);
    if (path === 'location' || path === 'time') {
        next[path] = value.trim();
        return { ok: true, state: next };
    }
    if (path === 'threads') {
        next.threads = value.split(';').map((t) => t.trim()).filter(Boolean);
        return { ok: true, state: next };
    }
    if (path.startsWith('present.')) {
        const { name, attr } = parsePresentPath(path.slice('present.'.length));
        if (!name) return { ok: false, error: 'missing character name after present.' };
        const index = next.present.findIndex((p) => key(p.name) === key(name));
        if (!attr) {
            if (value.trim()) return { ok: false, error: `use present.${name}= (empty) to remove, or present.${name}.outfit=... to set` };
            if (index >= 0) next.present.splice(index, 1);
            return { ok: true, state: next };
        }
        if (index >= 0) next.present[index][attr] = value.trim();
        else next.present.push({ name, outfit: '', condition: '', mood: '', [attr]: value.trim() });
        return { ok: true, state: next };
    }
    return { ok: false, error: `unknown scene path "${path}"` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/state.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/state.js tests/state.test.js
git commit -m "feat: add scene state schema, lookup and per-swipe records"
```

---

### Task 4: Evidence gate

**Files:**
- Create: `src/evidence.js`
- Test: `tests/evidence.test.js`

**Interfaces:**
- Consumes: `PERSON_ATTRS` from `src/state.js`.
- Produces:
  - `MIN_WORDS = 2`, `MIN_UNSPACED_CHARS = 3`, `normalize(text) → string` (NFKC, straight quotes incl. 「」『』), `quoteIsSpecific(needle) → boolean` (two words, or three characters in Han/Kana/Thai), `quoteProblem(quote, haystack) → null | 'no quote' | 'quote too short' | 'quote not found in messages'`, `verifyQuote(quote, haystack) → boolean`. The gate proves a quote exists, not that it supports the change.
  - `diffPaths(prev, next) → string[]` field paths that differ.
  - `applyEvidenceGate({ prev, next, evidence, sources, mesId, prevProvenance = {}, threadsCap = Infinity }) → { state, provenance, accepted: string[], rejected: [{ path, reason }] }`. Provenance entries: `{ mesId, quote }`. New threads beyond `threadsCap` are refused with reason `over thread cap` (no provenance, not accepted); closures are applied first, so closing a thread makes room.
  - Field paths: `location`, `time`, `present.<Name>`, `present.<Name>.<attr>`, `threads.<thread text>`.

- [ ] **Step 1: Write the failing test**

`tests/evidence.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, verifyQuote, quoteProblem, diffPaths, applyEvidenceGate } from '../src/evidence.js';
import { validateState } from '../src/state.js';

const S = (raw) => validateState(raw, { threadsCap: 99 }).state;
const prev = S({
    location: 'kitchen', time: 'night',
    present: [{ name: 'Ellen', outfit: 'hoodie', mood: 'annoyed' }, { name: 'Lycaon' }],
    threads: ['owes a favor', 'plushie missing'],
});

test('normalize lowercases, unifies quotes and whitespace, and drops markdown emphasis', () => {
    assert.equal(normalize('  *She  SMILES*\n“hi” ‘x’ … 「a」'), 'she smiles "hi" \'x\' ... "a"');
});

test('normalize maps full-width punctuation and letters to ASCII', () => {
    assert.equal(normalize('走吧，她说！ＯＫ'), '走吧,她说!ok');
});

test('verifyQuote needs a real, long-enough substring', () => {
    const hay = normalize('*Ellen pulls on the red coat.* "Let\'s go," she says.');
    assert.equal(verifyQuote('pulls on the red coat', hay), true);
    assert.equal(verifyQuote('"Ellen pulls on the red coat."', hay), true);
    assert.equal(verifyQuote('puts on a blue coat', hay), false);
    assert.equal(verifyQuote(null, hay), false);
});

test('single English words are too short to count as evidence', () => {
    const hay = normalize('She smiles at the rooftop door.');
    assert.equal(quoteProblem('the', hay), 'quote too short');
    assert.equal(quoteProblem('rooftop', hay), 'quote too short');
    assert.equal(quoteProblem('rooftop door', hay), null);
    assert.equal(quoteProblem(undefined, hay), 'no quote');
});

test('verifyQuote works for CJK text and corner brackets', () => {
    const hay = normalize('艾伦穿上了红色外套。「走吧」她说。');
    assert.equal(verifyQuote('穿上了红色外套', hay), true);
    assert.equal(verifyQuote('「走吧」她说', hay), true);
    assert.equal(verifyQuote('穿上了蓝色外套', hay), false);
    assert.equal(verifyQuote('走吧', hay), false);
});

test('a quote with ASCII punctuation matches full-width punctuation in the reply', () => {
    assert.equal(verifyQuote('走吧,她说', normalize('「走吧，她说。」')), true);
});

test('diffPaths lists every changed path', () => {
    const next = S({
        location: 'rooftop', time: 'night',
        present: [{ name: 'Ellen', outfit: 'red coat', mood: 'annoyed' }, { name: 'Anby' }],
        threads: ['owes a favor', 'meet at dawn'],
    });
    assert.deepEqual(diffPaths(prev, next).sort(), [
        'location', 'present.Anby', 'present.Ellen.outfit', 'present.Lycaon', 'threads.meet at dawn', 'threads.plushie missing',
    ].sort());
});

test('diffPaths is empty when nothing changed, ignoring case and spacing', () => {
    const same = S({ ...prev, location: 'Kitchen ' });
    assert.deepEqual(diffPaths(prev, same), []);
});

test('the gate accepts changes with verified quotes and records provenance', () => {
    const next = S({ ...prev, location: 'rooftop' });
    const gate = applyEvidenceGate({
        prev, next, evidence: { location: 'they climb onto the rooftop' },
        sources: ['', 'Together they climb onto the rooftop.'], mesId: 12,
    });
    assert.equal(gate.state.location, 'rooftop');
    assert.deepEqual(gate.accepted, ['location']);
    assert.deepEqual(gate.provenance.location, { mesId: 12, quote: 'they climb onto the rooftop' });
});

test('the gate reverts changes with missing or invented quotes', () => {
    const next = S({ ...prev, location: 'rooftop', time: 'dawn' });
    const gate = applyEvidenceGate({
        prev, next, evidence: { time: 'the sun rises' },
        sources: ['hi', 'They talk quietly.'], mesId: 3,
    });
    assert.equal(gate.state.location, 'kitchen');
    assert.equal(gate.state.time, 'night');
    assert.deepEqual(gate.rejected, [
        { path: 'location', reason: 'no quote' },
        { path: 'time', reason: 'quote not found in messages' },
    ]);
});

test('unchanged fields need no quote and keep their old provenance', () => {
    const gate = applyEvidenceGate({
        prev, next: prev, evidence: {}, sources: ['x'], mesId: 5,
        prevProvenance: { location: { mesId: 1, quote: 'in the kitchen' } },
    });
    assert.deepEqual(gate.state, prev);
    assert.deepEqual(gate.rejected, []);
    assert.deepEqual(gate.provenance, { location: { mesId: 1, quote: 'in the kitchen' } });
});

test('people entering, leaving and changing are each gated', () => {
    const next = S({
        ...prev,
        present: [{ name: 'Ellen', outfit: 'red coat', mood: 'happy' }, { name: 'Anby', outfit: 'jacket', mood: 'bored' }],
    });
    const reply = 'Lycaon leaves the room. Anby walks in wearing her jacket. Ellen pulls on a red coat.';
    const gate = applyEvidenceGate({
        prev, next, sources: ['', reply], mesId: 9,
        evidence: {
            'present.Lycaon': 'Lycaon leaves the room',
            'present.Anby': 'Anby walks in',
            'present.Anby.outfit': 'wearing her jacket',
            'present.Anby.mood': 'yawning',
            'present.Ellen.outfit': 'pulls on a red coat',
        },
    });
    assert.deepEqual(gate.state.present, [
        { name: 'Ellen', outfit: 'red coat', condition: '', mood: 'annoyed' },
        { name: 'Anby', outfit: 'jacket', condition: '', mood: '' },
    ]);
    assert.deepEqual(gate.rejected.map((r) => r.path).sort(), ['present.Anby.mood', 'present.Ellen.mood']);
});

test('removing a person drops their provenance', () => {
    const next = S({ ...prev, present: [prev.present[0]] });
    const gate = applyEvidenceGate({
        prev, next, sources: ['Lycaon heads out.'], mesId: 4,
        evidence: { 'present.Lycaon': 'Lycaon heads out' },
        prevProvenance: { 'present.Lycaon': { mesId: 1, quote: 'x' }, 'present.Lycaon.mood': { mesId: 1, quote: 'y' } },
    });
    assert.deepEqual(gate.state.present.map((p) => p.name), ['Ellen']);
    assert.deepEqual(gate.provenance, {});
});

test('threads opened and closed are each gated', () => {
    const next = S({ ...prev, threads: ['owes a favor', 'meet at dawn', 'find the key'] });
    const gate = applyEvidenceGate({
        prev, next, sources: ['', 'She finds the plushie under the bed. "Meet me at dawn."'], mesId: 7,
        evidence: { 'threads.plushie missing': 'finds the plushie', 'threads.meet at dawn': 'Meet me at dawn' },
    });
    assert.deepEqual(gate.state.threads, ['owes a favor', 'meet at dawn']);
    assert.deepEqual(gate.rejected, [{ path: 'threads.find the key', reason: 'no quote' }]);
});

test('new threads over the cap are refused visibly, without provenance', () => {
    const next = S({ ...prev, threads: ['owes a favor', 'plushie missing', 'meet at dawn'] });
    const gate = applyEvidenceGate({
        prev, next, sources: ['"Meet me at dawn."'], mesId: 8, threadsCap: 2,
        evidence: { 'threads.meet at dawn': 'Meet me at dawn' },
    });
    assert.deepEqual(gate.state.threads, ['owes a favor', 'plushie missing']);
    assert.deepEqual(gate.rejected, [{ path: 'threads.meet at dawn', reason: 'over thread cap' }]);
    assert.deepEqual(gate.accepted, []);
    assert.equal('threads.meet at dawn' in gate.provenance, false);
});

test('closing a thread makes room under the cap', () => {
    const next = S({ ...prev, threads: ['owes a favor', 'meet at dawn'] });
    const gate = applyEvidenceGate({
        prev, next, sources: ['She finds the plushie. "Meet me at dawn."'], mesId: 8, threadsCap: 2,
        evidence: { 'threads.plushie missing': 'finds the plushie', 'threads.meet at dawn': 'Meet me at dawn' },
    });
    assert.deepEqual(gate.state.threads, ['owes a favor', 'meet at dawn']);
});

test('evidence keys match case-insensitively', () => {
    const next = S({ ...prev, location: 'rooftop' });
    const gate = applyEvidenceGate({ prev, next, evidence: { LOCATION: 'on the rooftop' }, sources: ['on the rooftop'], mesId: 1 });
    assert.equal(gate.state.location, 'rooftop');
});

test('a non-object evidence value rejects every change', () => {
    const next = S({ ...prev, location: 'rooftop' });
    const gate = applyEvidenceGate({ prev, next, evidence: 'trust me', sources: ['rooftop'], mesId: 1 });
    assert.equal(gate.state.location, 'kitchen');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/evidence.test.js`
Expected: FAIL, `src/evidence.js` not found.

- [ ] **Step 3: Write the implementation**

`src/evidence.js`:
```js
import { PERSON_ATTRS } from './state.js';

// A quote must be specific enough to point at one change: two words in space-separated text,
// three characters in scripts written without spaces (Chinese, Japanese, Thai).
export const MIN_WORDS = 2;
export const MIN_UNSPACED_CHARS = 3;
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * NFKC (full-width punctuation and letters become ASCII, … becomes ...), lowercase, straight quotes
 * (curly quotes and CJK corner brackets), single spaces, no markdown emphasis characters.
 */
export function normalize(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[‘’‚‛]/g, "'")
        .replace(/[“”„‟「」『』]/g, '"')
        .replace(/[*_]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function quoteIsSpecific(needle) {
    if (UNSPACED.test(needle)) return [...needle].length >= MIN_UNSPACED_CHARS;
    return needle.split(' ').filter(Boolean).length >= MIN_WORDS;
}

/**
 * null when the quote (minus wrapping quote marks) is specific and appears in the normalised
 * haystack; otherwise why it does not count. This proves the quote exists in the messages,
 * not that it supports the change.
 */
export function quoteProblem(quote, haystack) {
    if (typeof quote !== 'string') return 'no quote';
    const needle = normalize(quote).replace(/^["']+|["']+$/g, '').trim();
    if (!quoteIsSpecific(needle)) return 'quote too short';
    return haystack.includes(needle) ? null : 'quote not found in messages';
}

export const verifyQuote = (quote, haystack) => quoteProblem(quote, haystack) === null;

const personKey = (name) => name.trim().toLowerCase();
const same = (a, b) => normalize(a) === normalize(b);

/** Field paths where next differs from prev. */
export function diffPaths(prev, next) {
    const paths = [];
    for (const field of ['location', 'time']) if (!same(prev[field], next[field])) paths.push(field);
    const before = new Map(prev.present.map((p) => [personKey(p.name), p]));
    const after = new Map(next.present.map((p) => [personKey(p.name), p]));
    for (const [id, person] of before) if (!after.has(id)) paths.push(`present.${person.name}`);
    for (const [id, person] of after) {
        const old = before.get(id);
        if (!old) paths.push(`present.${person.name}`);
        for (const attr of PERSON_ATTRS) if (!same(old?.[attr], person[attr])) paths.push(`present.${person.name}.${attr}`);
    }
    const oldThreads = new Set(prev.threads.map(normalize));
    const newThreads = new Set(next.threads.map(normalize));
    for (const thread of prev.threads) if (!newThreads.has(normalize(thread))) paths.push(`threads.${thread}`);
    for (const thread of next.threads) if (!oldThreads.has(normalize(thread))) paths.push(`threads.${thread}`);
    return paths;
}

function findQuote(evidence, path) {
    if (!evidence || typeof evidence !== 'object') return null;
    if (typeof evidence[path] === 'string') return evidence[path];
    const wanted = normalize(path);
    for (const [key, value] of Object.entries(evidence)) {
        if (typeof value === 'string' && normalize(key) === wanted) return value;
    }
    return null;
}

function dropProvenance(provenance, prefix) {
    for (const key of Object.keys(provenance)) {
        if (key === prefix || key.startsWith(`${prefix}.`)) delete provenance[key];
    }
}

/**
 * Keeps only the changes backed by a quote that really appears in the new messages.
 * Unchanged fields need no quote. Rejected changes keep the previous value. New threads beyond
 * threadsCap are refused (reported as "over thread cap"); closing old threads makes room.
 */
export function applyEvidenceGate({ prev, next, evidence, sources, mesId, prevProvenance = {}, threadsCap = Infinity }) {
    const haystack = normalize(sources.filter(Boolean).join('\n'));
    const accepted = [];
    const rejected = [];
    const provenance = { ...prevProvenance };
    const allow = (path) => {
        const quote = findQuote(evidence, path);
        const problem = quoteProblem(quote, haystack);
        if (problem === null) {
            accepted.push(path);
            provenance[path] = { mesId, quote: quote.trim() };
            return true;
        }
        rejected.push({ path, reason: problem });
        return false;
    };

    const state = structuredClone(prev);
    for (const field of ['location', 'time']) {
        if (!same(prev[field], next[field]) && allow(field)) state[field] = next[field];
    }

    const after = new Map(next.present.map((p) => [personKey(p.name), p]));
    state.present = state.present.filter((person) => {
        if (after.has(personKey(person.name))) return true;
        if (!allow(`present.${person.name}`)) return true;
        dropProvenance(provenance, `present.${person.name}`);
        return false;
    });
    for (const person of state.present) {
        const updated = after.get(personKey(person.name));
        if (!updated) continue;
        for (const attr of PERSON_ATTRS) {
            if (!same(person[attr], updated[attr]) && allow(`present.${person.name}.${attr}`)) person[attr] = updated[attr];
        }
    }
    const before = new Set(prev.present.map((p) => personKey(p.name)));
    for (const person of next.present) {
        if (before.has(personKey(person.name)) || !allow(`present.${person.name}`)) continue;
        const entry = { name: person.name, outfit: '', condition: '', mood: '' };
        for (const attr of PERSON_ATTRS) {
            if (person[attr] && allow(`present.${person.name}.${attr}`)) entry[attr] = person[attr];
        }
        state.present.push(entry);
    }

    const nextThreads = new Set(next.threads.map(normalize));
    state.threads = state.threads.filter((thread) => {
        if (nextThreads.has(normalize(thread))) return true;
        if (!allow(`threads.${thread}`)) return true;
        delete provenance[`threads.${thread}`];
        return false;
    });
    const prevThreads = new Set(prev.threads.map(normalize));
    for (const thread of next.threads) {
        if (prevThreads.has(normalize(thread))) continue;
        if (state.threads.length >= threadsCap) {
            rejected.push({ path: `threads.${thread}`, reason: 'over thread cap' });
            continue;
        }
        if (allow(`threads.${thread}`)) state.threads.push(thread);
    }

    return { state, provenance, accepted, rejected };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/evidence.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/evidence.js tests/evidence.test.js
git commit -m "feat: gate scene changes on verified quotes with provenance"
```

---

### Task 5: Story text and LLM helpers

**Files:**
- Create: `src/story.js`, `src/llm.js`
- Test: `tests/story.test.js`, `tests/llm.test.js`

**Interfaces:**
- Produces:
  - `extractStory(text, storyTags = ['content']) → string`, `parseTagList(value) → string[]`.
  - `parseJsonReply(text) → any` (throws `Error` with a readable message).
  - `createLlm(sendRequest) → { complete(profileId, messages, { maxTokens = 800, temperature, signal }) → Promise<string> }` where `sendRequest(profileId, messages, { maxTokens, temperature, signal }) → Promise<string | { content: string }>`.

- [ ] **Step 1: Write the failing tests**

`tests/story.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStory, parseTagList } from '../src/story.js';

test('keeps only story-tag content when present', () => {
    const text = '<ellen_planning~>plan</ellen_planning~>\n<content>She smiles.</content>\n<tracker>hp 3</tracker>';
    assert.equal(extractStory(text, ['content']), 'She smiles.');
});

test('without story tags, drops custom-tagged blocks and keeps the rest', () => {
    const text = '<ellen_planning~>\nthinking\n</ellen_planning~>\nShe smiles.\n<details>cot</details>';
    assert.equal(extractStory(text, ['content']), 'She smiles.');
});

test('unwraps plain HTML formatting instead of dropping it', () => {
    assert.equal(extractStory('She <b>really</b> smiles.<br>Then leaves.', []), 'She really smiles. Then leaves.');
});

test('an unclosed custom tag swallows the rest (cut-off CoT)', () => {
    assert.equal(extractStory('<thinking>never closed', []), '');
});

test('handles empty input', () => {
    assert.equal(extractStory('', ['content']), '');
    assert.equal(extractStory(undefined, ['content']), '');
});

test('parseTagList splits a comma list', () => {
    assert.deepEqual(parseTagList(' content, story ,, '), ['content', 'story']);
    assert.deepEqual(parseTagList(''), []);
});
```

`tests/llm.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonReply, createLlm } from '../src/llm.js';

test('parses plain, fenced and chatty JSON replies', () => {
    assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonReply('```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(parseJsonReply('Sure! Here it is: {"a":{"b":3}} Hope that helps.'), { a: { b: 3 } });
});

test('throws readable errors for bad replies', () => {
    assert.throws(() => parseJsonReply('no json here'), /no JSON object/);
    assert.throws(() => parseJsonReply('{"a":}'), /not valid JSON/);
    assert.throws(() => parseJsonReply(null), /not text/);
});

test('createLlm returns content from string or extracted-data replies', async () => {
    const calls = [];
    const llm = createLlm(async (...args) => { calls.push(args); return { content: 'hi', reasoning: 'x' }; });
    const signal = new AbortController().signal;
    assert.equal(await llm.complete('p1', [{ role: 'user', content: 'q' }], { maxTokens: 50, temperature: 0, signal }), 'hi');
    assert.deepEqual(calls[0], ['p1', [{ role: 'user', content: 'q' }], { maxTokens: 50, temperature: 0, signal }]);
    assert.equal(await createLlm(async () => 'plain').complete('p', []), 'plain');
});

test('createLlm throws on an empty reply', async () => {
    await assert.rejects(createLlm(async () => ({})).complete('p', []), /empty reply/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/story.test.js tests/llm.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

`src/story.js`:
```js
// Story text for scene extraction: the content of story tags if the reply has them, otherwise the
// reply with custom-tagged blocks (CoT, notes, trackers) removed. Ported from Laya WI Director's
// guard-heuristics.js (extractNarrative), with line breaks instead of " | " separators.

// Custom XML tags from CoT presets, e.g. <ellen_planning~>, <tucao>, <progress>.
const TAG_NAME = '[A-Za-z][\\w:~.-]*';
// Plain HTML formatting inside the story: unwrap (keep the text), don't drop.
// <details> is deliberately absent — presets use it to fold away CoT.
const HTML_FORMATTING = new Set([
    'b', 'i', 'u', 's', 'em', 'strong', 'span', 'font', 'small', 'big', 'sub', 'sup', 'del', 'ins',
    'mark', 'q', 'p', 'div', 'center', 'br', 'hr', 'img', 'a', 'code', 'blockquote', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
const isHtml = (name) => HTML_FORMATTING.has(name.toLowerCase());
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function unwrapHtml(text) {
    return text.replace(new RegExp(`</?(${TAG_NAME})(?:\\s[^>]*)?\\/?>`, 'g'), (tag, name) => (isHtml(name) ? ' ' : tag));
}

// Drop every custom-tagged block. An opening tag that never closes swallows the rest of the reply.
function stripTagged(text) {
    let out = unwrapHtml(text);
    const pair = new RegExp(`<(${TAG_NAME})(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>`, 'g');
    let prev;
    do {
        prev = out;
        out = out.replace(pair, '\n');
    } while (out !== prev);
    out = out.replace(new RegExp(`<${TAG_NAME}(?:\\s[^>]*)?>[\\s\\S]*$`), '\n');
    return out.replace(new RegExp(`</${TAG_NAME}\\s*>`, 'g'), '\n');
}

const tidy = (text) => text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * @param {string} text reply text
 * @param {string[]} storyTags tag names whose content is the story, e.g. ['content']
 */
export function extractStory(text, storyTags = ['content']) {
    if (!text) return '';
    const parts = [];
    for (const tag of storyTags.map((t) => t.trim()).filter(Boolean)) {
        const t = escapeRegex(tag);
        for (const match of text.matchAll(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)(?:</${t}\\s*>|$)`, 'gi'))) {
            parts.push(match[1]);
        }
    }
    return tidy(parts.length ? parts.map(stripTagged).join('\n') : stripTagged(text));
}

/** "content, story" → ['content', 'story'] */
export function parseTagList(value) {
    return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
```

`src/llm.js`:
```js
/**
 * Pulls the first JSON object out of a model reply (plain, fenced, or wrapped in chatter).
 * @param {string} text
 */
export function parseJsonReply(text) {
    if (typeof text !== 'string') throw new Error('model reply is not text');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in model reply');
    try {
        return JSON.parse(body.slice(start, end + 1));
    } catch (error) {
        throw new Error(`model reply is not valid JSON: ${error.message}`);
    }
}

/**
 * @param {(profileId: string, messages: object[], options: { maxTokens: number, temperature?: number, signal?: AbortSignal }) => Promise<any>} sendRequest
 */
export function createLlm(sendRequest) {
    return {
        async complete(profileId, messages, { maxTokens = 800, temperature, signal } = {}) {
            const result = await sendRequest(profileId, messages, { maxTokens, temperature, signal });
            const text = typeof result === 'string' ? result : result?.content;
            if (typeof text !== 'string' || !text.trim()) throw new Error('empty reply from connection profile');
            return text;
        },
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/story.test.js tests/llm.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/story.js src/llm.js tests/story.test.js tests/llm.test.js
git commit -m "feat: add story-text extraction and LLM reply helpers"
```

---

### Task 6: Brief stage

**Files:**
- Create: `src/stages/brief.js`
- Test: `tests/brief.test.js`

**Interfaces:**
- Consumes: `PERSON_ATTRS` (`src/state.js`), `DEFAULT_BRIEF_TEMPLATE` (`src/settings.js`).
- Produces:
  - `renderSceneLines(state, fields = {}) → string[]`, `renderSceneLine(state, fields) → string` (lines joined with ` | `), `renderBrief(state, { template, fields }) → string` (`''` when state is empty).
  - `createBriefStage({ briefStore: { value: string }, setPrompt: (text, depth) => void }) → Stage` (id `brief`, phase `plan`, `budgetExempt: true`). Output `{ brief }`. In `auto` mode it calls `setPrompt(brief, depth)`; in `macro` mode `setPrompt('', depth)`. Always sets `briefStore.value`. Reads scene field toggles from `turn.settings.stages.scene.fields`.

- [ ] **Step 1: Write the failing test**

`tests/brief.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSceneLines, renderSceneLine, renderBrief, createBriefStage } from '../src/stages/brief.js';
import { validateState, emptyState } from '../src/state.js';

const state = validateState({
    location: "Ellen's apartment, kitchen", time: 'late evening, raining',
    present: [{ name: 'Ellen', outfit: 'oversized hoodie', condition: 'tired', mood: 'annoyed' }, { name: 'Lycaon' }],
    threads: ['owes {{user}} a favor', 'shark plushie still missing'],
}).state;

test('renders every field', () => {
    assert.deepEqual(renderSceneLines(state), [
        "Location: Ellen's apartment, kitchen",
        'Time: late evening, raining',
        'Present: Ellen (oversized hoodie; tired; annoyed), Lycaon',
        'Open threads: owes {{user}} a favor; shark plushie still missing',
    ]);
});

test('leaves out empty and disabled fields', () => {
    const partial = { ...emptyState(), location: 'roof' };
    assert.deepEqual(renderSceneLines(partial), ['Location: roof']);
    assert.deepEqual(renderSceneLines(state, { threads: false, time: false }).length, 2);
});

test('renderSceneLine joins with pipes', () => {
    assert.equal(renderSceneLine({ ...emptyState(), location: 'a', time: 'b' }), 'Location: a | Time: b');
});

test('renderBrief uses the default template and is empty for an empty state', () => {
    const brief = renderBrief(state, {});
    assert.ok(brief.startsWith('<scene_notes>\nTracked scene notes.'));
    assert.ok(brief.includes('Location: Ellen'));
    assert.ok(brief.endsWith('</scene_notes>'));
    assert.equal(renderBrief(emptyState(), {}), '');
});

test('renderBrief appends when the template has no placeholder, and keeps $ patterns literal', () => {
    assert.equal(renderBrief({ ...emptyState(), location: 'roof' }, { template: 'Notes:' }), 'Notes:\nLocation: roof');
    assert.equal(renderBrief({ ...emptyState(), location: 'cost $& more' }, { template: '[{{scene}}]' }), '[Location: cost $& more]');
});

test('stage injects in auto mode and clears the prompt in macro mode', async () => {
    const calls = [];
    const briefStore = { value: '' };
    const stage = createBriefStage({ briefStore, setPrompt: (text, depth) => calls.push([text, depth]) });
    const turn = { settings: { stages: { scene: { fields: {} } } } };

    const auto = await stage.run(turn, state, { mode: 'auto', depth: 1, template: '' });
    assert.equal(calls[0][1], 1);
    assert.equal(calls[0][0], briefStore.value);
    assert.equal(auto.output.brief, briefStore.value);
    assert.match(auto.summary, /4 lines, auto/);
    assert.equal(stage.budgetExempt, true);

    await stage.run(turn, state, { mode: 'macro', depth: 2, template: '' });
    assert.deepEqual(calls[1], ['', 2]);
    assert.ok(briefStore.value.includes('Location:'));
});

test('stage reports an empty state', async () => {
    const stage = createBriefStage({ briefStore: { value: 'old' }, setPrompt: () => {} });
    const result = await stage.run({ settings: {} }, emptyState(), { mode: 'auto', depth: 1 });
    assert.equal(result.output.brief, '');
    assert.equal(result.summary, 'no scene state yet');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/brief.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

`src/stages/brief.js`:
```js
import { PERSON_ATTRS } from '../state.js';
import { DEFAULT_BRIEF_TEMPLATE } from '../settings.js';

/** One line per non-empty, enabled field. */
export function renderSceneLines(state, fields = {}) {
    const on = (field) => fields?.[field] !== false;
    const lines = [];
    if (on('location') && state.location) lines.push(`Location: ${state.location}`);
    if (on('time') && state.time) lines.push(`Time: ${state.time}`);
    if (on('present') && state.present.length) {
        const people = state.present.map((person) => {
            const attrs = PERSON_ATTRS.map((attr) => person[attr]).filter(Boolean);
            return attrs.length ? `${person.name} (${attrs.join('; ')})` : person.name;
        });
        lines.push(`Present: ${people.join(', ')}`);
    }
    if (on('threads') && state.threads.length) lines.push(`Open threads: ${state.threads.join('; ')}`);
    return lines;
}

export function renderSceneLine(state, fields) {
    return renderSceneLines(state, fields).join(' | ');
}

/** The brief block, or '' when there is nothing to say. */
export function renderBrief(state, { template, fields } = {}) {
    const lines = renderSceneLines(state, fields);
    if (!lines.length) return '';
    const body = lines.join('\n');
    const tpl = template || DEFAULT_BRIEF_TEMPLATE;
    // Function replacer: scene text may contain "$&" and similar patterns.
    return tpl.includes('{{scene}}') ? tpl.replace('{{scene}}', () => body) : `${tpl}\n${body}`;
}

/**
 * @param {{ briefStore: { value: string }, setPrompt: (text: string, depth: number) => void }} deps
 */
export function createBriefStage({ briefStore, setPrompt }) {
    return {
        id: 'brief',
        phase: 'plan',
        // Only string rendering: it must still run when the observe wait used up the plan budget.
        budgetExempt: true,
        async run(turn, state, config) {
            const fields = turn.settings?.stages?.scene?.fields;
            const brief = renderBrief(state, { template: config.template, fields });
            briefStore.value = brief;
            setPrompt(config.mode === 'macro' ? '' : brief, config.depth);
            const lines = renderSceneLines(state, fields).length;
            return { output: { brief }, summary: brief ? `${lines} lines, ${config.mode}` : 'no scene state yet' };
        },
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/brief.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/stages/brief.js tests/brief.test.js
git commit -m "feat: add brief stage rendering and injection"
```

---

### Task 7: Scene stage

**Files:**
- Create: `src/stages/scene.js`
- Test: `tests/scene.test.js`

**Interfaces:**
- Consumes: `validateState`, `FIELDS` (`src/state.js`); `applyEvidenceGate` (`src/evidence.js`); `parseJsonReply` (`src/llm.js`); an `llm` from `createLlm`.
- Produces:
  - `enabledFields(fields) → string[]`, `projectState(state, fields) → object`, `buildScenePrompt({ prev, userText, replyText, userName, charName, fields, threadsCap }) → [{ role: 'system', content }, { role: 'user', content }]`.
  - `createSceneStage({ llm }) → Stage` (id `scene`, phase `observe`). Sends `config.temperature`. Validates the model's state with `threadsCap: Infinity` and applies the cap once, in the gate. Expects `turn = { mesId, userText, replyText, userName, charName, prevProvenance, signal }`. Returns `{ statePatch: fullNewState, output: { provenance, accepted, rejected, warnings }, summary }`. Unavailable reason when `config.profileId` is empty: `'choose a connection profile for scene tracking'`.

- [ ] **Step 1: Write the failing test**

`tests/scene.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScenePrompt, createSceneStage, enabledFields, projectState } from '../src/stages/scene.js';
import { validateState } from '../src/state.js';

const prev = validateState({ location: 'kitchen', time: 'night', present: [{ name: 'Ellen', outfit: 'hoodie' }], threads: ['owes a favor'] }).state;
const config = { profileId: 'p1', maxTokens: 600, temperature: 0, threadsCap: 8, fields: { location: true, time: true, present: true, threads: true } };
const turn = (extra = {}) => ({
    mesId: 12, userText: 'I grab my jacket and we head up to the roof.',
    replyText: 'Ellen follows you onto the rooftop, pulling on her red coat.',
    userName: 'Mara', charName: 'Ellen', prevProvenance: {}, signal: new AbortController().signal, ...extra,
});
const fakeLlm = (reply) => {
    const calls = [];
    return { calls, complete: async (...args) => { calls.push(args); return typeof reply === 'function' ? reply() : reply; } };
};

test('enabledFields and projectState honour toggles', () => {
    assert.deepEqual(enabledFields({ time: false }), ['location', 'present', 'threads']);
    assert.deepEqual(Object.keys(projectState(prev, { threads: false, present: false })), ['location', 'time']);
});

test('buildScenePrompt includes names, previous state and the messages', () => {
    const [system, user] = buildScenePrompt({ prev, userText: 'hi', replyText: 'hello', userName: 'Mara', charName: 'Ellen', fields: config.fields, threadsCap: 8 });
    assert.equal(system.role, 'system');
    assert.match(system.content, /including Mara/);
    assert.match(system.content, /at most 8/);
    assert.match(system.content, /"present\.<Name>\.outfit"/);
    assert.match(user.content, /"location": "kitchen"/);
    assert.match(user.content, /Mara's message:\n"""\nhi\n"""/);
    assert.match(user.content, /Ellen's reply:\n"""\nhello\n"""/);
});

test('buildScenePrompt leaves out disabled fields', () => {
    const [system, user] = buildScenePrompt({ prev, userText: '', replyText: 'x', userName: 'Mara', charName: 'Ellen', fields: { ...config.fields, threads: false }, threadsCap: 8 });
    assert.doesNotMatch(system.content, /threads/);
    assert.doesNotMatch(user.content, /owes a favor/);
    assert.match(user.content, /Mara's message:\n"""\n\(none\)/);
});

test('unavailable without a connection profile', () => {
    const stage = createSceneStage({ llm: fakeLlm('{}') });
    assert.equal(stage.available({}, { ...config, profileId: '' }), 'choose a connection profile for scene tracking');
    assert.equal(stage.available({}, config), true);
});

test('accepts evidenced changes and rejects the rest', async () => {
    const llm = fakeLlm(JSON.stringify({
        state: { ...prev, location: 'rooftop', time: 'dawn', present: [{ name: 'Ellen', outfit: 'red coat' }] },
        evidence: { location: 'onto the rooftop', 'present.Ellen.outfit': 'pulling on her red coat' },
    }));
    const stage = createSceneStage({ llm });
    const t = turn();
    const result = await stage.run(t, prev, config);
    assert.equal(result.statePatch.location, 'rooftop');
    assert.equal(result.statePatch.time, 'night');
    assert.equal(result.statePatch.present[0].outfit, 'red coat');
    assert.deepEqual(result.output.accepted.sort(), ['location', 'present.Ellen.outfit']);
    assert.deepEqual(result.output.rejected, [{ path: 'time', reason: 'no quote' }]);
    assert.deepEqual(result.output.provenance.location, { mesId: 12, quote: 'onto the rooftop' });
    assert.equal(result.summary, '2 change(s) accepted, 1 rejected');
    assert.equal(llm.calls[0][0], 'p1');
    assert.deepEqual(llm.calls[0][2], { maxTokens: 600, temperature: 0, signal: t.signal });
});

test('accepts a state returned without the wrapper object', async () => {
    const stage = createSceneStage({ llm: fakeLlm(JSON.stringify({ ...prev, location: 'rooftop' })) });
    const result = await stage.run(turn(), prev, config);
    assert.equal(result.statePatch.location, 'kitchen');
    assert.deepEqual(result.output.rejected, [{ path: 'location', reason: 'no quote' }]);
});

test('malformed JSON and invalid state throw so the stage fails', async () => {
    await assert.rejects(createSceneStage({ llm: fakeLlm('not json') }).run(turn(), prev, config), /no JSON object/);
    await assert.rejects(createSceneStage({ llm: fakeLlm('{"state":{"location":5}}') }).run(turn(), prev, config), /invalid scene state: location/);
});

test('disabled fields keep the previous value whatever the model says', async () => {
    const llm = fakeLlm(JSON.stringify({ state: { ...prev, threads: [] }, evidence: { 'threads.owes a favor': 'head up to the roof' } }));
    const result = await createSceneStage({ llm }).run(turn(), prev, { ...config, fields: { ...config.fields, threads: false } });
    assert.deepEqual(result.statePatch.threads, ['owes a favor']);
});

test('a new thread over the cap is refused and reported', async () => {
    const full = validateState({ ...prev, threads: ['a', 'b'] }).state;
    const llm = fakeLlm(JSON.stringify({ state: { ...full, threads: ['a', 'b', 'roof trip'] }, evidence: { 'threads.roof trip': 'head up to the roof' } }));
    const result = await createSceneStage({ llm }).run(turn(), full, { ...config, threadsCap: 2 });
    assert.deepEqual(result.statePatch.threads, ['a', 'b']);
    assert.deepEqual(result.output.rejected, [{ path: 'threads.roof trip', reason: 'over thread cap' }]);
    assert.equal('threads.roof trip' in result.output.provenance, false);
});

test('skips replies with no story text', async () => {
    const llm = fakeLlm('{}');
    const result = await createSceneStage({ llm }).run(turn({ replyText: '  ' }), prev, config);
    assert.equal(result.skip, 'reply has no story text');
    assert.equal(llm.calls.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/scene.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

`src/stages/scene.js`:
```js
import { validateState, FIELDS } from '../state.js';
import { applyEvidenceGate } from '../evidence.js';
import { parseJsonReply } from '../llm.js';

const FIELD_HELP = {
    location: '"location": where the scene takes place.',
    time: '"time": time of day, date, weather, or other timing that matters.',
    present: '"present": everyone physically in the scene, including {user}. Each entry is {"name", "outfit", "condition", "mood"}; "condition" covers injuries, exhaustion, intoxication and similar physical states.',
    threads: '"threads": open plot threads, promises and unresolved questions, one short phrase each, at most {cap}. Keep the existing order, add new ones at the end, and remove ones that are resolved.',
};

const PATH_HELP = {
    location: '"location"',
    time: '"time"',
    present: '"present.<Name>" (someone arrived or left), "present.<Name>.outfit", "present.<Name>.condition", "present.<Name>.mood"',
    threads: '"threads.<thread text>" (a thread was opened or resolved)',
};

export const enabledFields = (fields = {}) => FIELDS.filter((field) => fields?.[field] !== false);

/** The state with only enabled fields, for showing to the model. */
export function projectState(state, fields) {
    return Object.fromEntries(enabledFields(fields).map((field) => [field, state[field]]));
}

export function buildScenePrompt({ prev, userText, replyText, userName, charName, fields, threadsCap }) {
    const on = enabledFields(fields);
    const system = [
        'You track the scene of an ongoing roleplay. Read the previous scene state and the two newest messages, then return the updated scene state.',
        '',
        'State fields:',
        ...on.map((field) => `- ${FIELD_HELP[field].replace('{user}', userName).replace('{cap}', String(threadsCap))}`),
        '',
        'Rules:',
        '- Change a field only when the new messages show that it changed. Otherwise copy it exactly from the previous state.',
        '- For every change, add an entry to "evidence". The key is the field path; the value is a short quote copied word for word from one of the two messages that shows the change.',
        `- Field paths: ${on.map((field) => PATH_HELP[field]).join(', ')}.`,
        '- A change without an exact quote is thrown away, so do not guess.',
        '- Reply with JSON only, in this shape: {"state": {...}, "evidence": {"<field path>": "<exact quote>"}}',
    ].join('\n');
    const user = [
        'Previous scene state:',
        JSON.stringify(projectState(prev, fields), null, 2),
        '',
        `${userName}'s message:`,
        '"""',
        userText?.trim() || '(none)',
        '"""',
        '',
        `${charName}'s reply:`,
        '"""',
        replyText.trim(),
        '"""',
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function keepDisabledFields(next, prev, fields) {
    const out = { ...next };
    for (const field of FIELDS) if (fields?.[field] === false) out[field] = structuredClone(prev[field]);
    return out;
}

/** @param {{ llm: { complete: Function } }} deps */
export function createSceneStage({ llm }) {
    return {
        id: 'scene',
        phase: 'observe',
        available(_ctx, config) {
            return config.profileId ? true : 'choose a connection profile for scene tracking';
        },
        async run(turn, state, config) {
            if (!turn.replyText?.trim()) return { skip: 'reply has no story text' };
            const messages = buildScenePrompt({
                prev: state, userText: turn.userText, replyText: turn.replyText,
                userName: turn.userName, charName: turn.charName, fields: config.fields, threadsCap: config.threadsCap,
            });
            const text = await llm.complete(config.profileId, messages, {
                maxTokens: config.maxTokens, temperature: config.temperature, signal: turn.signal,
            });
            const parsed = parseJsonReply(text);
            const rawState = parsed && typeof parsed.state === 'object' ? parsed.state : parsed;
            // The thread cap is applied once, in the gate, so refusals are visible.
            const checked = validateState(rawState, { threadsCap: Infinity });
            if (!checked.ok) throw new Error(`invalid scene state: ${checked.error}`);
            const next = keepDisabledFields(checked.state, state, config.fields);
            const gate = applyEvidenceGate({
                prev: state, next, evidence: parsed?.evidence, sources: [turn.userText, turn.replyText],
                mesId: turn.mesId, prevProvenance: turn.prevProvenance ?? {}, threadsCap: config.threadsCap,
            });
            return {
                statePatch: gate.state,
                output: { provenance: gate.provenance, accepted: gate.accepted, rejected: gate.rejected, warnings: checked.warnings },
                summary: `${gate.accepted.length} change(s) accepted, ${gate.rejected.length} rejected`,
            };
        },
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/scene.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/stages/scene.js tests/scene.test.js
git commit -m "feat: add scene extraction stage with evidence gate"
```

---

### Task 8: Memory stage and backends

**Files:**
- Create: `src/backends/memory/summaryception.js`, `src/backends/memory/none.js`, `src/stages/memory.js`, `tests/fixtures/summaryception-store.json`
- Test: `tests/memory.test.js`

**Interfaces:**
- Consumes: `resolveBackend` (`src/backends/resolve.js`), `runPhase` (for the none-backend test).
- Produces:
  - Memory backend shape: `{ id, label, available(ctx) → true|string, getSummary(ctx) → string|null }`. `ctx = { extensionSettings, chatMetadata, disabledExtensions }`.
  - `summaryceptionMemory`, `noneMemory`, `MEMORY_BACKENDS = { summaryception, none }`.
  - `createMemoryStage({ backends = MEMORY_BACKENDS }) → Stage` (id `memory`, phase `plan`). Output `{ summary, source }`.

- [ ] **Step 1: Create the fixture**

`tests/fixtures/summaryception-store.json` (same shape as a real `chatMetadata.summaryception` store: `layers[n][]` of `{ text, turnRange, timestamp }`):
```json
{
    "layers": [
        [
            { "text": "Mara and Ellen search the kitchen for the shark plushie.", "turnRange": [11, 16], "timestamp": 1790309645917 },
            { "text": "Ellen admits she owes Mara a favor.", "turnRange": [17, 22], "timestamp": 1790310359705 }
        ],
        [
            { "text": "Mara moves into Victoria Housekeeping's building.", "turnRange": [0, 10], "timestamp": 1790308840269 }
        ]
    ],
    "summarizedUpTo": 22,
    "ghostedIndices": [0, 1, 2]
}
```

- [ ] **Step 2: Write the failing test**

`tests/memory.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summaryceptionMemory } from '../src/backends/memory/summaryception.js';
import { noneMemory } from '../src/backends/memory/none.js';
import { createMemoryStage } from '../src/stages/memory.js';
import { runPhase } from '../src/runner.js';

const store = JSON.parse(readFileSync(new URL('./fixtures/summaryception-store.json', import.meta.url)));
const ctx = (overrides = {}) => ({
    extensionSettings: { summaryception: { enabled: true } },
    chatMetadata: { summaryception: structuredClone(store) },
    disabledExtensions: [],
    ...overrides,
});

test('reads higher layers first, then layer 0', () => {
    assert.equal(
        summaryceptionMemory.getSummary(ctx()),
        "Mara moves into Victoria Housekeeping's building. Mara and Ellen search the kitchen for the shark plushie. Ellen admits she owes Mara a favor.",
    );
});

test('skips malformed layers and snippets', () => {
    const c = ctx();
    c.chatMetadata.summaryception.layers = [[{ text: 'ok' }, { text: 5 }, null, { nope: 1 }], 'bad', [{ text: '  ' }]];
    assert.equal(summaryceptionMemory.getSummary(c), 'ok');
    c.chatMetadata.summaryception.layers = [];
    assert.equal(summaryceptionMemory.getSummary(c), null);
    assert.equal(summaryceptionMemory.getSummary({}), null);
});

test('availability explains what is missing', () => {
    assert.equal(summaryceptionMemory.available(ctx()), true);
    assert.equal(summaryceptionMemory.available(ctx({ extensionSettings: {} })), 'Summaryception is not installed');
    assert.equal(summaryceptionMemory.available(ctx({ disabledExtensions: ['third-party/Extension-Summaryception'] })), 'Summaryception is disabled');
    assert.equal(summaryceptionMemory.available(ctx({ extensionSettings: { summaryception: { enabled: false } } })), 'Summaryception is turned off');
    assert.equal(summaryceptionMemory.available(ctx({ chatMetadata: {} })), 'no Summaryception summary in this chat yet');
});

test('none backend is always available and returns nothing', () => {
    assert.equal(noneMemory.available({}), true);
    assert.equal(noneMemory.getSummary({}), null);
});

test('stage outputs the summary', async () => {
    const stage = createMemoryStage();
    const result = await stage.run({ ctx: ctx() }, {}, { backend: 'summaryception' });
    assert.match(result.output.summary, /^Mara moves in/);
    assert.equal(result.output.source, 'summaryception');
});

test('stage is unavailable with the reason when the backend is missing or none', () => {
    const stage = createMemoryStage();
    assert.equal(stage.available(ctx({ extensionSettings: {} }), { backend: 'summaryception' }), 'Summaryception is not installed');
    assert.equal(stage.available(ctx(), { backend: 'none' }), 'memory source is set to none');
});

test('stage skips a store with no readable snippets', async () => {
    const c = ctx();
    c.chatMetadata.summaryception.layers = [[]];
    const result = await createMemoryStage().run({ ctx: c }, {}, { backend: 'summaryception' });
    assert.equal(result.skip, 'Summaryception has no readable summary');
});

test('runs cleanly in the runner with the none backend', async () => {
    const result = await runPhase([createMemoryStage()], {
        phase: 'plan', turn: { ctx: ctx() }, state: {}, settings: { stages: { memory: { backend: 'none' } } },
    });
    assert.deepEqual(result.reports.map((r) => r.status), ['skipped']);
    assert.deepEqual(result.outputs, {});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/memory.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 4: Write the implementation**

`src/backends/memory/summaryception.js`:
```js
// The only file that knows Summaryception's storage format (chatMetadata.summaryception).
// Mirrors its assembleSummaryBlock(): higher layers first (last down to 1), then layer 0.
// Summaryception keeps injecting the summary itself; this only reads it.
export const summaryceptionMemory = {
    id: 'summaryception',
    label: 'Summaryception',
    available(ctx) {
        const settings = ctx?.extensionSettings?.summaryception;
        if (!settings) return 'Summaryception is not installed';
        if ((ctx.disabledExtensions ?? []).some((name) => /summaryception$/i.test(name))) return 'Summaryception is disabled';
        if (settings.enabled === false) return 'Summaryception is turned off';
        if (!Array.isArray(ctx.chatMetadata?.summaryception?.layers)) return 'no Summaryception summary in this chat yet';
        return true;
    },
    getSummary(ctx) {
        const layers = ctx?.chatMetadata?.summaryception?.layers;
        if (!Array.isArray(layers) || !layers.length) return null;
        const texts = [];
        for (const layer of [...layers.slice(1).reverse(), layers[0]]) {
            if (!Array.isArray(layer)) continue;
            for (const snippet of layer) {
                if (typeof snippet?.text === 'string' && snippet.text.trim()) texts.push(snippet.text.trim());
            }
        }
        return texts.length ? texts.join(' ') : null;
    },
};
```

`src/backends/memory/none.js`:
```js
export const noneMemory = {
    id: 'none',
    label: 'None',
    available: () => true,
    getSummary: () => null,
};
```

`src/stages/memory.js`:
```js
import { resolveBackend } from '../backends/resolve.js';
import { summaryceptionMemory } from '../backends/memory/summaryception.js';
import { noneMemory } from '../backends/memory/none.js';

export const MEMORY_BACKENDS = { summaryception: summaryceptionMemory, none: noneMemory };

export function createMemoryStage({ backends = MEMORY_BACKENDS } = {}) {
    return {
        id: 'memory',
        phase: 'plan',
        available(ctx, config) {
            const { backend, reason } = resolveBackend(backends, config.backend, ctx);
            return backend.id === 'none' ? (reason ?? 'memory source is set to none') : true;
        },
        async run(turn, _state, config) {
            const { backend } = resolveBackend(backends, config.backend, turn.ctx);
            const summary = backend.getSummary(turn.ctx);
            if (!summary) return { skip: `${backend.label} has no readable summary` };
            return { output: { summary, source: backend.id }, summary: `${backend.label}, ${summary.length} chars` };
        },
    };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/memory.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/backends/memory src/stages/memory.js tests/memory.test.js tests/fixtures/summaryception-store.json
git commit -m "feat: add memory stage with Summaryception and none backends"
```

---

### Task 9: Laya scorer and Lore stage

**Files:**
- Create: `src/backends/scorers/laya.js`, `src/backends/scorers/none.js`, `src/stages/lore.js`
- Test: `tests/laya.test.js`, `tests/lore.test.js`

**Interfaces:**
- Consumes: `resolveBackend`, `BackendUnavailableError` (`src/backends/resolve.js`); `renderSceneLine` (`src/stages/brief.js`).
- Produces:
  - Scorer shape: `{ id, label, available(ctx) → true|string, score(candidates: [{ id, content }], context: { message, recent }, { serviceUrl, signal }) → Promise<[{ id, relevance, usefulness }]> }`.
  - `createLayaScorer({ fetchImpl = fetch, now = Date.now }) → scorer & { health(serviceUrl) → Promise<boolean> }` (health times out after `HEALTH_TIMEOUT_MS = 3000`); `DOWN_RETRY_MS = 60000`. Network errors mark the service down for `DOWN_RETRY_MS` and throw `BackendUnavailableError`.
  - `noneScorer`.
  - Lore helpers: `AT_DEPTH_POSITION = 4`, `MAX_ENTRY_CHARS = 1600`, `SCORER_CONTEXT_CHARS = 1600`, `MESSAGE_CHARS = 600`, `SUMMARY_CHARS = 400`, `entryId(entry) → '<world>.<uid>'`, `selectCandidates(activated, { maxCandidates, protectCachePrefix }) → { pool, total }`, `rankAndFill(pool, scores, config, tokensOf) → { kept, dropped }` (items `{ entry, id, score, tokens, why?, unscored? }`; entries with no score are kept and not charged to `budgetTokens`), `buildScorerContext({ chatForWI, recentTurns, sceneText, summary }) → { message, recent }`, `applySuppression(data, suppression) → number`, `layaDirectorConflict(ctx) → boolean`.
  - `createLoreStage({ scorers, scanWorldInfo, countTokens, suppression, includeNames }) → Stage` (id `lore`, phase `plan`). `scanWorldInfo(chatForWI, contextSize) → Promise<entry[]>`, `countTokens(text) → Promise<number>`, `suppression: Set<string>`, `includeNames() → Promise<boolean>` (ST's own `world_info_include_names`, so the dry run matches the real scan). Output `{ kept, dropped, droppedTokens, judged, unjudged }`. Plan turn needs `chat` (ST's interceptor chat, oldest first), `contextSize`, `outputs.memory`.

- [ ] **Step 1: Write the failing tests**

`tests/laya.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayaScorer, DOWN_RETRY_MS } from '../src/backends/scorers/laya.js';
import { BackendUnavailableError } from '../src/backends/resolve.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('posts candidates and maps results', async () => {
    const requests = [];
    const scorer = createLayaScorer({ fetchImpl: async (url, init) => { requests.push([url, JSON.parse(init.body)]); return ok({ results: [{ id: 'w.1', relevance: 4, usefulness: '3' }, { bad: true }] }); } });
    const result = await scorer.score([{ id: 'w.1', content: 'lore' }], { message: 'm', recent: ['r'] }, { serviceUrl: 'http://x:1/' });
    assert.deepEqual(result, [{ id: 'w.1', relevance: 4, usefulness: 3 }]);
    assert.equal(requests[0][0], 'http://x:1/wi-director');
    assert.deepEqual(requests[0][1], { message: 'm', recent_turns: ['r'], candidates: [{ id: 'w.1', content: 'lore' }] });
});

test('a network error marks the service down until the retry time', async () => {
    let clock = 1000;
    const scorer = createLayaScorer({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, now: () => clock });
    await assert.rejects(scorer.score([], { message: '', recent: [] }, { serviceUrl: 'http://x' }), BackendUnavailableError);
    assert.match(scorer.available(), /Laya service unreachable/);
    clock += DOWN_RETRY_MS;
    assert.equal(scorer.available(), true);
});

test('an HTTP error is a plain failure', async () => {
    const scorer = createLayaScorer({ fetchImpl: async () => ({ ok: false, status: 500 }) });
    await assert.rejects(scorer.score([], { message: '', recent: [] }, { serviceUrl: 'http://x' }), /returned 500/);
    assert.equal(scorer.available(), true);
});

test('an aborted request does not mark the service down', async () => {
    const controller = new AbortController();
    controller.abort();
    const scorer = createLayaScorer({ fetchImpl: async () => { throw new DOMException('aborted', 'AbortError'); } });
    await assert.rejects(scorer.score([], { message: '', recent: [] }, { serviceUrl: 'http://x', signal: controller.signal }), /aborted/);
    assert.equal(scorer.available(), true);
});

test('health gives up on a host that never answers', async () => {
    const scorer = createLayaScorer({ fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }) });
    const started = Date.now();
    assert.equal(await scorer.health('http://10.255.255.1'), false);
    assert.ok(Date.now() - started < 3500);
});

test('health checks /health and clears the down state', async () => {
    let up = false;
    const scorer = createLayaScorer({ fetchImpl: async (url) => { if (!up) throw new TypeError('down'); assert.equal(url, 'http://x/health'); return ok({ status: 'ok' }); } });
    await assert.rejects(scorer.score([], { message: '', recent: [] }, { serviceUrl: 'http://x' }));
    assert.notEqual(scorer.available(), true);
    assert.equal(await scorer.health('http://x'), false);
    up = true;
    assert.equal(await scorer.health('http://x'), true);
    assert.equal(scorer.available(), true);
});
```

`tests/lore.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    selectCandidates, rankAndFill, buildScorerContext, applySuppression, layaDirectorConflict,
    createLoreStage, entryId, SCORER_CONTEXT_CHARS,
} from '../src/stages/lore.js';
import { noneScorer } from '../src/backends/scorers/none.js';
import { BackendUnavailableError } from '../src/backends/resolve.js';
import { validateState } from '../src/state.js';

const entry = (uid, extra = {}) => ({ world: 'w', uid, content: `lore ${uid}`, position: 4, ...extra });
const config = { backend: 'fake', maxCandidates: 25, budgetTokens: 1024, recentTurns: 4, wRelevance: 1, wUsefulness: 1, minScore: 1, protectCachePrefix: false, serviceUrl: 'http://x' };

test('selectCandidates skips constant, disabled and empty entries and caps the pool', () => {
    const activated = [entry(1, { constant: true }), entry(2, { disable: true }), entry(3, { content: ' ' }), entry(4), entry(5), entry(6)];
    const { pool, total } = selectCandidates(activated, { ...config, maxCandidates: 2 });
    assert.deepEqual(pool.map((e) => e.uid), [4, 5]);
    assert.equal(total, 3);
});

test('protectCachePrefix only judges @depth entries', () => {
    const { pool } = selectCandidates([entry(1, { position: 0 }), entry(2, { position: 4 })], { ...config, protectCachePrefix: true });
    assert.deepEqual(pool.map((e) => e.uid), [2]);
});

test('rankAndFill ranks, applies the floor and fills the budget', () => {
    const pool = [entry(1), entry(2), entry(3), entry(4)];
    const scores = [
        { id: 'w.1', relevance: 5, usefulness: 5 },
        { id: 'w.2', relevance: 0, usefulness: 0.5 },
        { id: 'w.3', relevance: 3, usefulness: 3 },
    ];
    const tokens = { 1: 1000, 2: 10, 3: 500, 4: 300 };
    const { kept, dropped } = rankAndFill(pool, scores, config, (e) => tokens[e.uid]);
    // w.4 is unscored: kept but not charged, so w.1 (1000 tokens) still fits the 1024 budget.
    assert.deepEqual(kept.map((k) => [k.id, Boolean(k.unscored)]), [['w.4', true], ['w.1', false]]);
    assert.deepEqual(dropped.map((d) => [d.id, d.why]), [['w.3', 'over budget'], ['w.2', 'low score']]);
});

test('buildScorerContext puts scene and summary first and stays within budget', () => {
    const chatForWI = ['Mara: newest', 'Ellen: older', 'Mara: oldest'];
    const ctx = buildScorerContext({ chatForWI, recentTurns: 4, sceneText: 'Location: roof', summary: 'x'.repeat(1000) });
    assert.equal(ctx.message, 'Mara: newest');
    assert.equal(ctx.recent[0], 'Scene: Location: roof');
    assert.ok(ctx.recent[1].startsWith('Story so far: '));
    assert.equal(ctx.recent[1].length, 'Story so far: '.length + 400);
    assert.deepEqual(ctx.recent.slice(2), chatForWI);
    const long = buildScorerContext({ chatForWI: ['y'.repeat(5000), 'z'.repeat(5000)], recentTurns: 4, sceneText: '', summary: null });
    assert.ok(long.recent.join('').length <= SCORER_CONTEXT_CHARS);
    assert.equal(long.message.length, 600);
});

test('applySuppression disables matching entries in every lore list', () => {
    const data = { globalLore: [entry(1), entry(2)], characterLore: [entry(3)], chatLore: null, personaLore: [] };
    assert.equal(applySuppression(data, new Set(['w.2', 'w.3'])), 2);
    assert.deepEqual([data.globalLore[0].disable, data.globalLore[1].disable, data.characterLore[0].disable], [undefined, true, true]);
    assert.equal(applySuppression(data, new Set()), 0);
    assert.equal(applySuppression(null, new Set(['w.1'])), 0);
});

test('layaDirectorConflict only when the standalone director is enabled and loaded', () => {
    const on = { extensionSettings: { laya_wi_director: { enabled: true } }, disabledExtensions: [] };
    assert.equal(layaDirectorConflict(on), true);
    assert.equal(layaDirectorConflict({ ...on, disabledExtensions: ['third-party/laya-wi-director'] }), false);
    assert.equal(layaDirectorConflict({ extensionSettings: { laya_wi_director: { enabled: false } } }), false);
    assert.equal(layaDirectorConflict({ extensionSettings: {} }), false);
});

function makeStage({ scores = [], scoreError = null, activated = [entry(1), entry(2), entry(3)], names = true } = {}) {
    const suppression = new Set();
    const seen = {};
    const fake = {
        id: 'fake', label: 'Fake', available: () => true,
        score: async (candidates, context, options) => { seen.candidates = candidates; seen.context = context; seen.options = options; if (scoreError) throw scoreError; return scores; },
    };
    const stage = createLoreStage({
        scorers: { fake, none: noneScorer },
        scanWorldInfo: async (chatForWI, contextSize) => { seen.scan = [chatForWI, contextSize]; return activated; },
        countTokens: async (text) => text.length,
        suppression,
        includeNames: async () => names,
    });
    return { stage, suppression, seen };
}

const turn = (extra = {}) => ({
    chat: [{ name: 'Ellen', mes: 'hello' }, { name: 'Mara', mes: 'hi there' }],
    contextSize: 8000, ctx: { extensionSettings: {} }, outputs: { memory: { summary: 'story' } },
    signal: new AbortController().signal, ...extra,
});
const state = validateState({ location: 'roof' }).state;

test('stage scores candidates, suppresses dropped entries and reports', async () => {
    const { stage, suppression, seen } = makeStage({ scores: [
        { id: 'w.1', relevance: 5, usefulness: 5 }, { id: 'w.2', relevance: 0, usefulness: 0 }, { id: 'w.3', relevance: 4, usefulness: 4 },
    ] });
    const result = await stage.run(turn(), state, config);
    assert.deepEqual(seen.scan, [['Mara: hi there', 'Ellen: hello'], 8000]);
    assert.deepEqual(seen.candidates, [{ id: 'w.1', content: 'lore 1' }, { id: 'w.2', content: 'lore 2' }, { id: 'w.3', content: 'lore 3' }]);
    assert.equal(seen.context.recent[0], 'Scene: Location: roof');
    assert.equal(seen.context.recent[1], 'Story so far: story');
    assert.equal(seen.options.serviceUrl, 'http://x');
    assert.deepEqual([...suppression], ['w.2']);
    assert.deepEqual(result.output, { kept: 2, dropped: 1, droppedTokens: 6, judged: 3, unjudged: 0 });
    assert.equal(result.summary, 'kept 2, dropped 1, ~6 tokens saved');
});

test('the dry-run scan follows ST\'s include-names setting', async () => {
    const { stage, seen } = makeStage({ names: false });
    await stage.run(turn(), state, config);
    assert.deepEqual(seen.scan[0], ['hi there', 'hello']);
});

test('stage skips when one or no entries matched', async () => {
    const { stage } = makeStage({ activated: [entry(1)] });
    assert.equal((await stage.run(turn(), state, config)).skip, '1 entry to judge');
});

test('stage skips with the none scorer or an unreachable service', async () => {
    assert.match((await makeStage().stage.run(turn(), state, { ...config, backend: 'none' })).skip, /lore scorer is set to none/);
    const { stage, suppression } = makeStage({ scoreError: new BackendUnavailableError('Laya service unreachable at http://x') });
    assert.equal((await stage.run(turn(), state, config)).skip, 'Laya service unreachable at http://x');
    assert.equal(suppression.size, 0);
});

test('stage does not suppress anything once its signal has aborted', async () => {
    const controller = new AbortController();
    const { stage, suppression } = makeStage({ scores: [{ id: 'w.1', relevance: 0, usefulness: 0 }] });
    controller.abort();
    const result = await stage.run(turn({ signal: controller.signal }), state, config);
    assert.equal(result.skip, 'aborted');
    assert.equal(suppression.size, 0);
});

test('stage is unavailable while Laya WI Director prunes lore', () => {
    const { stage } = makeStage();
    const reason = stage.available({ extensionSettings: { laya_wi_director: { enabled: true } }, disabledExtensions: [] }, config);
    assert.match(reason, /Laya WI Director is pruning lore/);
    assert.equal(stage.available({ extensionSettings: {} }, config), true);
});

test('entryId joins world and uid', () => {
    assert.equal(entryId({ world: 'ZZZ', uid: 7 }), 'ZZZ.7');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/laya.test.js tests/lore.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

`src/backends/scorers/laya.js`:
```js
import { BackendUnavailableError } from '../resolve.js';

// How long to treat the service as down after a connection error before trying again.
export const DOWN_RETRY_MS = 60000;
export const HEALTH_TIMEOUT_MS = 3000;

const trimUrl = (url) => String(url ?? '').replace(/\/+$/, '');

/** Scores lore entries with the local Laya service (POST /wi-director, GET /health). */
export function createLayaScorer({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
    let downUntil = 0;
    return {
        id: 'laya',
        label: 'Laya',
        available() {
            if (now() < downUntil) return `Laya service unreachable; retrying in ${Math.ceil((downUntil - now()) / 1000)} s`;
            return true;
        },
        async score(candidates, context, { serviceUrl, signal } = {}) {
            let response;
            try {
                response = await fetchImpl(`${trimUrl(serviceUrl)}/wi-director`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: context.message, recent_turns: context.recent, candidates }),
                    signal,
                });
            } catch (error) {
                if (signal?.aborted) throw error;
                downUntil = now() + DOWN_RETRY_MS;
                throw new BackendUnavailableError(`Laya service unreachable at ${serviceUrl}`);
            }
            if (!response.ok) throw new Error(`Laya service returned ${response.status}`);
            const data = await response.json();
            downUntil = 0;
            return (data?.results ?? [])
                .filter((r) => typeof r?.id === 'string')
                .map((r) => ({ id: r.id, relevance: Number(r.relevance) || 0, usefulness: Number(r.usefulness) || 0 }));
        },
        async health(serviceUrl) {
            try {
                const response = await fetchImpl(`${trimUrl(serviceUrl)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
                if (response.ok) downUntil = 0;
                return response.ok;
            } catch {
                return false;
            }
        },
    };
}
```

`src/backends/scorers/none.js`:
```js
export const noneScorer = {
    id: 'none',
    label: 'None',
    available: () => true,
    score: async () => [],
};
```

`src/stages/lore.js`:
```js
import { resolveBackend, BackendUnavailableError } from '../backends/resolve.js';
import { renderSceneLine } from './brief.js';

export const AT_DEPTH_POSITION = 4; // world_info_position.atDepth in public/scripts/world-info.js
export const MAX_ENTRY_CHARS = 1600;
// Laya reads at most 1024 tokens: the question, the entry and this context together.
export const SCORER_CONTEXT_CHARS = 1600;
export const MESSAGE_CHARS = 600;
export const SUMMARY_CHARS = 400;

export const entryId = (entry) => `${entry.world}.${entry.uid}`;

/** Entries the scorer may judge: not constant, not disabled, not empty; @depth only when protecting the cache prefix. */
export function selectCandidates(activated, { maxCandidates, protectCachePrefix }) {
    const judgeable = activated.filter((entry) => !entry.constant && !entry.disable && (entry.content ?? '').trim()
        && (!protectCachePrefix || entry.position === AT_DEPTH_POSITION));
    return { pool: judgeable.slice(0, maxCandidates), total: judgeable.length };
}

/**
 * Ranks by weighted score and greedily fills the token budget. Entries the scorer returned no
 * score for are kept without being charged to the budget, so they cannot crowd out scored ones.
 */
export function rankAndFill(pool, scores, { wRelevance, wUsefulness, minScore, budgetTokens }, tokensOf) {
    const scoreById = new Map(scores.map((s) => [s.id, wRelevance * s.relevance + wUsefulness * s.usefulness]));
    const ranked = pool
        .map((entry) => ({ entry, id: entryId(entry), score: scoreById.get(entryId(entry)) ?? Infinity }))
        .sort((a, b) => b.score - a.score);
    let budget = budgetTokens;
    const kept = [];
    const dropped = [];
    for (const item of ranked) {
        const tokens = tokensOf(item.entry);
        if (item.score === Infinity) {
            kept.push({ ...item, tokens, unscored: true });
        } else if (item.score < minScore) {
            dropped.push({ ...item, tokens, why: 'low score' });
        } else if (tokens > budget) {
            dropped.push({ ...item, tokens, why: 'over budget' });
        } else {
            budget -= tokens;
            kept.push({ ...item, tokens });
        }
    }
    return { kept, dropped };
}

/** Scene notes, recent summary and recent turns (newest first), trimmed to SCORER_CONTEXT_CHARS. */
export function buildScorerContext({ chatForWI, recentTurns, sceneText, summary }) {
    const recent = [];
    let used = 0;
    const push = (line) => {
        const room = SCORER_CONTEXT_CHARS - used;
        if (!line || room <= 0) return;
        const text = line.length > room ? line.slice(-room) : line;
        recent.push(text);
        used += text.length;
    };
    if (sceneText) push(`Scene: ${sceneText}`);
    if (summary) push(`Story so far: ${summary.slice(-SUMMARY_CHARS)}`);
    for (const line of chatForWI.slice(0, recentTurns)) push(line);
    return { message: (chatForWI[0] ?? '').slice(-MESSAGE_CHARS), recent };
}

/** WORLDINFO_ENTRIES_LOADED handler body: flags suppressed entries before ST's real scan clones them. */
export function applySuppression(data, suppression) {
    if (!suppression.size || !data) return 0;
    let applied = 0;
    for (const list of [data.globalLore, data.characterLore, data.chatLore, data.personaLore]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (suppression.has(entryId(entry))) {
                entry.disable = true;
                applied++;
            }
        }
    }
    return applied;
}

/** True when the standalone Laya WI Director is loaded and pruning lore. */
export function layaDirectorConflict(ctx) {
    if (!ctx?.extensionSettings?.laya_wi_director?.enabled) return false;
    return !(ctx.disabledExtensions ?? []).some((name) => /laya-wi-director$/i.test(name));
}

/**
 * @param {{ scorers: object, scanWorldInfo: Function, countTokens: Function, suppression: Set<string>,
 *   includeNames: () => Promise<boolean> }} deps  includeNames reads ST's own World Info setting.
 */
export function createLoreStage({ scorers, scanWorldInfo, countTokens, suppression, includeNames }) {
    return {
        id: 'lore',
        phase: 'plan',
        available(ctx, config) {
            if (layaDirectorConflict(ctx)) return 'Laya WI Director is pruning lore; turn off its Enable to use this stage';
            const { backend, reason } = resolveBackend(scorers, config.backend, ctx);
            return backend.id === 'none' ? (reason ?? 'lore scorer is set to none') : true;
        },
        async run(turn, state, config) {
            const { backend: scorer, reason } = resolveBackend(scorers, config.backend, turn.ctx);
            if (scorer.id === 'none') return { skip: reason ?? 'lore scorer is set to none' };

            // Same text ST's real scan uses (script.js), newest first, so the dry run matches it.
            const withNames = await includeNames();
            const chatForWI = turn.chat.map((m) => (withNames ? `${m.name}: ${m.mes}` : m.mes)).reverse();
            const activated = await scanWorldInfo(chatForWI, turn.contextSize);
            const { pool, total } = selectCandidates(activated, config);
            if (pool.length <= 1) return { skip: `${pool.length} ${pool.length === 1 ? 'entry' : 'entries'} to judge` };

            const context = buildScorerContext({
                chatForWI, recentTurns: config.recentTurns,
                sceneText: renderSceneLine(state), summary: turn.outputs.memory?.summary ?? null,
            });
            let scores;
            try {
                scores = await scorer.score(
                    pool.map((entry) => ({ id: entryId(entry), content: entry.content.slice(0, MAX_ENTRY_CHARS) })),
                    context,
                    { serviceUrl: config.serviceUrl, signal: turn.signal },
                );
            } catch (error) {
                if (error instanceof BackendUnavailableError) return { skip: error.message };
                throw error;
            }
            const tokens = new Map(await Promise.all(pool.map(async (entry) => [entryId(entry), await countTokens(entry.content)])));
            if (turn.signal?.aborted) return { skip: 'aborted' };

            const { kept, dropped } = rankAndFill(pool, scores, config, (entry) => tokens.get(entryId(entry)));
            for (const item of dropped) suppression.add(item.id);
            const droppedTokens = dropped.reduce((sum, item) => sum + item.tokens, 0);
            return {
                output: { kept: kept.length, dropped: dropped.length, droppedTokens, judged: pool.length, unjudged: total - pool.length },
                summary: `kept ${kept.length}, dropped ${dropped.length}, ~${droppedTokens} tokens saved`,
            };
        },
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/laya.test.js tests/lore.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/backends/scorers src/stages/lore.js tests/laya.test.js tests/lore.test.js
git commit -m "feat: add lore stage with Laya scorer and in-memory suppression"
```

---

### Task 10: Observe scheduler

**Files:**
- Create: `src/observe.js`
- Test: `tests/observe.test.js`

**Interfaces:**
- Produces: `class ObserveScheduler({ run: (mesId, signal) => Promise, onError?: (error, mesId) => void })`. Runs one job at a time, in start order (a queued job cancelled before its turn never runs). Methods:
  - `schedule(mesId, delayMs)`: (re)start the settle timer; aborts a run already in progress for that message (its text changed).
  - `start(mesId) → Promise`: run now (or return the running promise).
  - `cancel(mesId)`, `cancelAll()`, `isPending(mesId) → boolean` (waiting or running).
  - `flush(mesId, waitMs) → Promise<boolean>`: start a waiting job now and wait for it (and everything queued before it) up to `waitMs`; `true` if it finished (or nothing was pending).

- [ ] **Step 1: Write the failing test**

`tests/observe.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObserveScheduler } from '../src/observe.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recorder({ delay = 0, fail = false } = {}) {
    const runs = [];
    const run = async (mesId, signal) => {
        const entry = { mesId, signal, done: false };
        runs.push(entry);
        if (delay) await sleep(delay);
        if (fail) throw new Error('boom');
        entry.done = true;
    };
    return { runs, run };
}

test('runs once after the settle delay, debouncing repeated schedules', async () => {
    const { runs, run } = recorder();
    const scheduler = new ObserveScheduler({ run });
    scheduler.schedule(3, 20);
    await sleep(10);
    scheduler.schedule(3, 20);
    assert.equal(scheduler.isPending(3), true);
    await sleep(40);
    assert.equal(runs.length, 1);
    assert.equal(scheduler.isPending(3), false);
});

test('rescheduling while running aborts the run and starts again', async () => {
    const { runs, run } = recorder({ delay: 30 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.start(1);
    await sleep(5);
    scheduler.schedule(1, 5);
    assert.equal(runs[0].signal.aborted, true);
    await sleep(100);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].signal.aborted, false);
    assert.equal(scheduler.isPending(1), false);
});

test('runs one at a time, in start order', async () => {
    const order = [];
    const scheduler = new ObserveScheduler({ run: async (mesId) => { order.push(`start ${mesId}`); await sleep(15); order.push(`end ${mesId}`); } });
    scheduler.start(1);
    scheduler.start(2);
    assert.equal(await scheduler.flush(2, 200), true);
    assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('a queued job cancelled before its turn never runs', async () => {
    const { runs, run } = recorder({ delay: 20 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.start(1);
    scheduler.start(2);
    scheduler.cancel(2);
    await sleep(50);
    assert.deepEqual(runs.map((r) => r.mesId), [1]);
});

test('cancel stops a waiting job and aborts a running one', async () => {
    const { runs, run } = recorder({ delay: 30 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.schedule(1, 10);
    scheduler.cancel(1);
    scheduler.start(2);
    await sleep(5);
    scheduler.cancel(2);
    assert.equal(runs[0].mesId, 2);
    assert.equal(runs[0].signal.aborted, true);
    await sleep(40);
    assert.equal(runs.length, 1);
    assert.equal(scheduler.isPending(1) || scheduler.isPending(2), false);
});

test('cancelAll clears everything', async () => {
    const { runs, run } = recorder();
    const scheduler = new ObserveScheduler({ run });
    scheduler.schedule(1, 10);
    scheduler.schedule(2, 10);
    scheduler.cancelAll();
    await sleep(30);
    assert.equal(runs.length, 0);
});

test('flush starts a waiting job now and waits for it', async () => {
    const { runs, run } = recorder({ delay: 10 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.schedule(4, 10000);
    assert.equal(await scheduler.flush(4, 200), true);
    assert.equal(runs[0].done, true);
    assert.equal(await scheduler.flush(99, 10), true);
});

test('flush gives up after waitMs but the run continues', async () => {
    const { runs, run } = recorder({ delay: 60 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.start(4);
    assert.equal(await scheduler.flush(4, 10), false);
    await sleep(80);
    assert.equal(runs[0].done, true);
});

test('run errors go to onError unless the run was aborted', async () => {
    const errors = [];
    const { run } = recorder({ fail: true });
    const scheduler = new ObserveScheduler({ run, onError: (error, mesId) => errors.push([error.message, mesId]) });
    await scheduler.start(7);
    assert.deepEqual(errors, [['boom', 7]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/observe.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

`src/observe.js`:
```js
/**
 * Runs Observe once per message after its text settles. A new event for the same message restarts
 * the timer, and aborts a run in progress because the text it read is out of date.
 * Runs happen one at a time, in the order they start, so each reply's observe builds on the state
 * the previous reply's observe wrote (group chats, catch-up).
 */
export class ObserveScheduler {
    constructor({ run, onError = () => {} }) {
        this.run = run;
        this.onError = onError;
        /** @type {Map<number, { timer: any, controller: AbortController|null, promise: Promise|null }>} */
        this.jobs = new Map();
        this.tail = Promise.resolve();
    }

    schedule(mesId, delayMs) {
        const job = this.jobs.get(mesId) ?? { timer: null, controller: null, promise: null };
        if (job.timer !== null) clearTimeout(job.timer);
        job.controller?.abort();
        job.controller = null;
        job.promise = null;
        job.timer = setTimeout(() => { this.start(mesId); }, delayMs);
        this.jobs.set(mesId, job);
    }

    start(mesId) {
        let job = this.jobs.get(mesId);
        if (!job) {
            job = { timer: null, controller: null, promise: null };
            this.jobs.set(mesId, job);
        }
        if (job.timer !== null) {
            clearTimeout(job.timer);
            job.timer = null;
        }
        if (job.promise) return job.promise;
        const controller = new AbortController();
        job.controller = controller;
        job.promise = this.tail
            .then(() => (controller.signal.aborted ? undefined : this.run(mesId, controller.signal)))
            .catch((error) => {
                if (!controller.signal.aborted) this.onError(error, mesId);
            })
            .finally(() => {
                if (this.jobs.get(mesId) === job && job.controller === controller) this.jobs.delete(mesId);
            });
        this.tail = job.promise;
        return job.promise;
    }

    cancel(mesId) {
        const job = this.jobs.get(mesId);
        if (!job) return;
        if (job.timer !== null) clearTimeout(job.timer);
        job.controller?.abort();
        this.jobs.delete(mesId);
    }

    cancelAll() {
        for (const mesId of [...this.jobs.keys()]) this.cancel(mesId);
    }

    isPending(mesId) {
        return this.jobs.has(mesId);
    }

    /** Starts a waiting job now and waits up to waitMs. Resolves true if it finished in time. */
    async flush(mesId, waitMs) {
        if (!this.jobs.has(mesId)) return true;
        const promise = this.start(mesId);
        let timer;
        const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); });
        const finished = await Promise.race([promise.then(() => true), timedOut]);
        clearTimeout(timer);
        return finished;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/observe.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/observe.js tests/observe.test.js
git commit -m "feat: add settle-and-cancel observe scheduler"
```

---

### Task 11: Session stats

**Files:**
- Create: `src/stats.js`
- Test: `tests/stats.test.js`

**Interfaces:**
- Produces: `createStats(limit = 200) → Stats`, `recordPlan(stats, { ms, reports, briefTokens, droppedTokens })`, `recordStageTimes(stats, reports)`, `percentile(values, p) → number|null`, `summarizeStats(stats) → { turns, plan: { p50, p95 }, stages: { [id]: { n, p50, p95 } }, avgBriefTokens, avgDroppedTokens }`.

- [ ] **Step 1: Write the failing test**

`tests/stats.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStats, recordPlan, recordStageTimes, percentile, summarizeStats } from '../src/stats.js';

test('percentile uses nearest rank', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([5], 95), 5);
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(percentile(values, 50), 50);
    assert.equal(percentile(values, 95), 95);
    assert.equal(percentile([3, 1, 2], 50), 2);
});

test('records plans and stage times, only for stages that ran', () => {
    const stats = createStats();
    recordPlan(stats, { ms: 100, reports: [{ id: 'lore', status: 'ran', ms: 80 }, { id: 'memory', status: 'skipped', ms: 0 }], briefTokens: 40, droppedTokens: 300 });
    recordPlan(stats, { ms: 300, reports: [{ id: 'lore', status: 'ran', ms: 250 }], briefTokens: 60, droppedTokens: 100 });
    recordStageTimes(stats, [{ id: 'scene', status: 'ran', ms: 900 }, { id: 'scene', status: 'failed', ms: 20000 }]);
    const summary = summarizeStats(stats);
    assert.equal(summary.turns, 2);
    assert.deepEqual(summary.plan, { p50: 100, p95: 300 });
    assert.deepEqual(summary.stages.lore, { n: 2, p50: 80, p95: 250 });
    assert.deepEqual(summary.stages.scene, { n: 1, p50: 900, p95: 900 });
    assert.equal(summary.stages.memory, undefined);
    assert.equal(summary.avgBriefTokens, 50);
    assert.equal(summary.avgDroppedTokens, 200);
});

test('keeps only the last `limit` values', () => {
    const stats = createStats(2);
    for (const ms of [1, 2, 3]) recordPlan(stats, { ms, reports: [], briefTokens: 0, droppedTokens: 0 });
    assert.deepEqual(stats.planMs, [2, 3]);
});

test('empty stats summarise to nulls', () => {
    assert.deepEqual(summarizeStats(createStats()), {
        turns: 0, plan: { p50: null, p95: null }, stages: {}, avgBriefTokens: null, avgDroppedTokens: null,
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/stats.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

`src/stats.js`:
```js
export function createStats(limit = 200) {
    return { limit, planMs: [], briefTokens: [], droppedTokens: [], stageMs: {} };
}

function push(list, value, limit) {
    list.push(value);
    if (list.length > limit) list.shift();
}

/** Nearest-rank percentile, or null for no values. */
export function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function recordStageTimes(stats, reports) {
    for (const report of reports) {
        if (report.status === 'ran') push(stats.stageMs[report.id] ??= [], report.ms, stats.limit);
    }
}

export function recordPlan(stats, { ms, reports, briefTokens, droppedTokens }) {
    push(stats.planMs, ms, stats.limit);
    push(stats.briefTokens, briefTokens, stats.limit);
    push(stats.droppedTokens, droppedTokens, stats.limit);
    recordStageTimes(stats, reports);
}

const average = (values) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

export function summarizeStats(stats) {
    return {
        turns: stats.planMs.length,
        plan: { p50: percentile(stats.planMs, 50), p95: percentile(stats.planMs, 95) },
        stages: Object.fromEntries(Object.entries(stats.stageMs).map(([id, values]) => [
            id, { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) },
        ])),
        avgBriefTokens: average(stats.briefTokens),
        avgDroppedTokens: average(stats.droppedTokens),
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/stats.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/stats.js tests/stats.test.js
git commit -m "feat: add session timing and token stats"
```

---

### Task 12: Conductor orchestration

**Files:**
- Create: `src/conductor.js`
- Test: `tests/conductor.test.js`

**Interfaces:**
- Consumes: `runPhase`, `FailureTracker` (Task 2); state helpers (Task 3); `diffPaths` (Task 4); `extractStory`, `parseTagList` (Task 5); `applySuppression` (Task 9); `ObserveScheduler` (Task 10); stats (Task 11); `createBriefStage` (Task 6, tests only).
- Produces:
  - `observeInput(chat, mesId, settings) → { userText, replyText, textHash }`.
  - `CATCH_UP_LIMIT = 4`, `catchUpIndices(chat, before, settings, limit) → number[]`: AI replies after the last user message whose record is missing or out of date, oldest first. Plan observes all of them (in order) and waits `observeWaitMs` for the last.
  - `createConductor({ deps, stages, suppression, briefStore }) → Conductor`.
  - `deps`: `{ getSettings(), getChat(), getChatId(), getContextView(), names() → { userName, charName }, saveChat() → Promise, setBriefPrompt(text, depth), countTokens(text) → Promise<number>, notify(stageId, reason, count), onUpdate(), now?(), log?(error) }`.
  - `Conductor`: `plan(coreChat, contextSize, type)`, `observe(mesId, signal)`, event handlers `onMessageReceived(mesId, type)`, `onMessageEdited(mesId)`, `onMessageSwiped(mesId)`, `onMessageDeleted()`, `onGenerationStarted(type, options, dryRun)`, `onGenerationStopped()`, `onGenerationEnded()`, `onChatChanged()`, `onWorldInfoLoaded(data)`; `currentView() → { chatId, index, stateIndex, state, textHash, provenance, stale, observed, pending }`; `setState(raw, expected?: { chatId, index, textHash }) → Promise<{ ok, error?, state? }>` (refuses when the chat, the latest message, or its text changed; cancels an in-flight observe of that message; stamps the record with the message's current text hash so Plan never re-extracts over the edit); `observe()` discards its result if the record changed while it ran; `editField(path, value) → Promise<{ ok, error?, state? }>`; `retry() → Promise`; `statusText() → string`; `clearBrief()`; `session: { lastPlan, lastObserve, stats }`.

- [ ] **Step 1: Write the failing test**

`tests/conductor.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConductor, observeInput, catchUpIndices } from '../src/conductor.js';
import { createBriefStage } from '../src/stages/brief.js';
import { mergeDefaults } from '../src/settings.js';
import { makeRecord, validateState } from '../src/state.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const user = (mes) => ({ is_user: true, name: 'Mara', mes });
const ai = (mes) => ({ is_user: false, name: 'Ellen', mes, extra: {} });

// Scene stand-in: the reply text becomes the location. Records what it saw.
function fakeScene({ fail = false, delay = 0 } = {}) {
    const calls = [];
    return {
        calls,
        stage: {
            id: 'scene', phase: 'observe', available: () => true,
            async run(turn, state) {
                calls.push({ mesId: turn.mesId, prevLocation: state.location, userText: turn.userText });
                if (delay) await sleep(delay);
                if (fail) throw new Error('model down');
                return {
                    statePatch: { location: turn.replyText },
                    output: { provenance: { location: { mesId: turn.mesId, quote: turn.replyText } }, accepted: ['location'], rejected: [] },
                };
            },
        },
    };
}

function harness({ chat = [], overrides = {}, scene = fakeScene() } = {}) {
    const settings = mergeDefaults({ settleMs: 10, observeWaitMs: 300, planBudgetMs: 1000, ...overrides });
    const calls = { saved: 0, prompts: [], notes: [], updates: 0 };
    let chatId = 'chat-1';
    const briefStore = { value: '' };
    const suppression = new Set();
    const deps = {
        getSettings: () => settings,
        getChat: () => chat,
        getChatId: () => chatId,
        getContextView: () => ({ extensionSettings: {}, chatMetadata: {}, disabledExtensions: [] }),
        names: () => ({ userName: 'Mara', charName: 'Ellen' }),
        saveChat: async () => { calls.saved++; },
        setBriefPrompt: (text, depth) => calls.prompts.push([text, depth]),
        countTokens: async (text) => Math.ceil(text.length / 4),
        notify: (id, reason, count) => calls.notes.push([id, reason, count]),
        onUpdate: () => { calls.updates++; },
    };
    const stages = [createBriefStage({ briefStore, setPrompt: deps.setBriefPrompt }), scene.stage];
    const conductor = createConductor({ deps, stages, suppression, briefStore });
    return { conductor, chat, settings, calls, briefStore, suppression, scene, switchChat: (id) => { chatId = id; } };
}

function record(chat, index, settings, raw, extra = {}) {
    const { textHash } = observeInput(chat, index, settings);
    chat[index].extra = { conductor: makeRecord({ state: validateState(raw).state, source: 'scene', textHash, ...extra }) };
}

const lastPrompt = (calls) => calls.prompts.at(-1)?.[0] ?? '';

test('observeInput pairs a reply with its user message and strips CoT', () => {
    const settings = mergeDefaults({});
    const chat = [user('hi'), ai('<thinking>x</thinking>Hello there.')];
    const input = observeInput(chat, 1, settings);
    assert.equal(input.userText, 'hi');
    assert.equal(input.replyText, 'Hello there.');
    assert.match(input.textHash, /^[0-9a-f]{8}$/);
});

test('observeInput gives consecutive group replies an empty user message', () => {
    const chat = [user('hi'), ai('Ellen speaks.'), { ...ai('Lycaon speaks.'), name: 'Lycaon' }];
    assert.equal(observeInput(chat, 2, mergeDefaults({})).userText, '');
});

test('quiet generations do nothing', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    await h.conductor.plan([], 8000, 'quiet');
    assert.deepEqual(h.calls.prompts, []);
    assert.equal(h.scene.calls.length, 0);
});

test('when disabled, the brief is cleared and no stage runs', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], overrides: { enabled: false } });
    await h.conductor.plan([], 8000, 'normal');
    assert.deepEqual(h.calls.prompts, [['', 1]]);
    assert.equal(h.scene.calls.length, 0);
});

test('continue keeps the previous brief', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    await h.conductor.plan([], 8000, 'continue');
    assert.deepEqual(h.calls.prompts, []);
});

test('plan injects the brief from the latest fresh state', async () => {
    const h = harness({ chat: [ai('hi'), user('u'), ai('talk')] });
    record(h.chat, 2, h.settings, { location: 'kitchen' });
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 0);
    assert.match(lastPrompt(h.calls), /Location: kitchen/);
    assert.equal(h.calls.prompts.at(-1)[1], 1);
    assert.equal(h.briefStore.value, lastPrompt(h.calls));
    assert.deepEqual(h.conductor.session.lastPlan.reports.map((r) => [r.id, r.status]), [['brief', 'ran']]);
});

test('a swipe reads state from before the message being replaced', async () => {
    const h = harness({ chat: [ai('a'), user('u'), ai('b')] });
    record(h.chat, 0, h.settings, { location: 'A' });
    record(h.chat, 2, h.settings, { location: 'B' });
    await h.conductor.plan([], 8000, 'swipe');
    assert.match(lastPrompt(h.calls), /Location: A/);
});

test('plan observes an unobserved latest reply first (bootstrap / commit mode)', async () => {
    const h = harness({ chat: [user('u'), ai('rooftop')] });
    await h.conductor.plan([], 8000, 'normal');
    assert.deepEqual(h.scene.calls.map((c) => c.mesId), [1]);
    assert.equal(h.chat[1].extra.conductor.state.location, 'rooftop');
    assert.equal(h.chat[1].extra.conductor.source, 'scene');
    assert.equal(h.calls.saved, 1);
    assert.match(lastPrompt(h.calls), /Location: rooftop/);
});

test('a fresh record is not observed again; an edited reply is', async () => {
    const h = harness({ chat: [user('u'), ai('rooftop')] });
    await h.conductor.plan([], 8000, 'normal');
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 1);
    h.chat[1].mes = 'garden';
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 2);
    assert.match(lastPrompt(h.calls), /Location: garden/);
});

test('settled mode observes after the reply arrives; commit mode waits', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'normal');
    assert.equal(h.conductor.currentView().pending, true);
    await sleep(40);
    assert.equal(h.chat[1].extra.conductor.state.location, 'roof');

    const c = harness({ chat: [user('u'), ai('roof')], overrides: { observeTrigger: 'commit' } });
    c.conductor.onMessageReceived(1, 'normal');
    assert.equal(c.conductor.currentView().pending, false);
});

test('quiet and impersonate replies are not observed', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'quiet');
    h.conductor.onMessageReceived(1, 'impersonate');
    assert.equal(h.conductor.currentView().pending, false);
});

test('plan flushes a pending observe before reading state', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], overrides: { settleMs: 10000 } });
    h.conductor.onMessageReceived(1, 'normal');
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 1);
    assert.match(lastPrompt(h.calls), /Location: roof/);
});

test('editing a user message re-observes the reply after it', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageEdited(0);
    await sleep(40);
    assert.deepEqual(h.scene.calls.map((c) => c.mesId), [1]);
});

test('a failed observe copies the previous state forward as stale and warns after the threshold', async () => {
    const scene = fakeScene({ fail: true });
    const h = harness({ chat: [ai('a'), user('u'), ai('b')], scene });
    record(h.chat, 0, h.settings, { location: 'kitchen' });
    await h.conductor.retry();
    const rec = h.chat[2].extra.conductor;
    assert.equal(rec.stale, true);
    assert.equal(rec.state.location, 'kitchen');
    assert.equal(h.conductor.currentView().stale, true);
    await h.conductor.retry();
    assert.equal(h.calls.notes.length, 0);
    await h.conductor.retry();
    assert.deepEqual(h.calls.notes, [['scene', 'model down', 3]]);
});

test('a result is discarded when the chat changes mid-observe', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const running = h.conductor.observe(1, new AbortController().signal);
    h.switchChat('chat-2');
    await running;
    assert.equal(h.chat[1].extra.conductor, undefined);
});

test('a result is discarded when the message is deleted or swiped mid-observe', async () => {
    const deleted = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const original = deleted.chat[1];
    const a = deleted.conductor.observe(1, new AbortController().signal);
    deleted.chat[1] = ai('other');
    await a;
    assert.equal(original.extra.conductor, undefined);
    assert.equal(deleted.chat[1].extra.conductor, undefined);

    const swiped = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const b = swiped.conductor.observe(1, new AbortController().signal);
    swiped.chat[1].mes = 'a different swipe';
    await b;
    assert.equal(swiped.chat[1].extra.conductor, undefined);
});

test('a manual record on the message is the base for re-observing it', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.chat[1].extra = { conductor: makeRecord({ state: validateState({ location: 'library' }).state, source: 'manual' }) };
    await h.conductor.retry();
    assert.equal(h.scene.calls[0].prevLocation, 'library');
});

test('editField writes a manual record with manual provenance', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    record(h.chat, 1, h.settings, { location: 'roof' });
    const result = await h.conductor.editField('present.Ellen.outfit', 'red coat');
    assert.equal(result.ok, true);
    const rec = h.chat[1].extra.conductor;
    assert.equal(rec.source, 'manual');
    assert.equal(rec.state.present[0].outfit, 'red coat');
    assert.deepEqual(rec.provenance['present.Ellen.outfit'], { mesId: null, quote: null, manual: true });
    assert.equal(h.calls.saved, 1);
    assert.equal((await h.conductor.editField('weather', 'rain')).ok, false);
});

test('editField needs a character message', async () => {
    const h = harness({ chat: [user('u')] });
    assert.deepEqual(await h.conductor.editField('location', 'x'), { ok: false, error: 'no character message to attach the scene to yet' });
});

test('suppression is cleared at plan start and applied on WORLDINFO_ENTRIES_LOADED', async () => {
    const h = harness({ chat: [user('u')] });
    h.suppression.add('w.1');
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.suppression.size, 0);
    h.suppression.add('w.2');
    const data = { globalLore: [{ world: 'w', uid: 2 }] };
    assert.equal(h.conductor.onWorldInfoLoaded(data), 1);
    assert.equal(data.globalLore[0].disable, true);
    h.conductor.onGenerationEnded();
    assert.equal(h.suppression.size, 0);
});

test('a chat change cancels pending observes and clears the brief', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'normal');
    h.conductor.onChatChanged();
    await sleep(40);
    assert.equal(h.scene.calls.length, 0);
    assert.deepEqual(h.calls.prompts.at(-1), ['', 1]);
});

test('swiping cancels the pending observe for that message', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'normal');
    h.conductor.onMessageSwiped(1);
    await sleep(40);
    assert.equal(h.scene.calls.length, 0);
});

test('the brief still runs when the observe wait uses the whole plan budget', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], overrides: { planBudgetMs: 20, observeWaitMs: 300 }, scene: fakeScene({ delay: 60 }) });
    await h.conductor.plan([], 8000, 'normal');
    const brief = h.conductor.session.lastPlan.reports.find((r) => r.id === 'brief');
    assert.equal(brief.status, 'ran');
    assert.match(lastPrompt(h.calls), /Location: roof/);
});

test('commit mode observes every reply of a group turn, in order', async () => {
    const lycaon = { ...ai('in the rain'), name: 'Lycaon' };
    const h = harness({ chat: [user('u'), ai('on the roof'), lycaon], overrides: { observeTrigger: 'commit' } });
    await h.conductor.plan([], 8000, 'normal');
    assert.deepEqual(h.scene.calls.map((c) => [c.mesId, c.prevLocation]), [[1, ''], [2, 'on the roof']]);
    assert.match(lastPrompt(h.calls), /Location: in the rain/);
});

test('catch-up stays within the current run and stops at a current record', () => {
    const settings = mergeDefaults({});
    const chat = [ai('old'), user('u'), ai('a'), ai('b'), ai('c')];
    assert.deepEqual(catchUpIndices(chat, chat.length, settings), [2, 3, 4]);
    record(chat, 3, settings, { location: 'x' });
    assert.deepEqual(catchUpIndices(chat, chat.length, settings), [4]);
    const long = [user('u'), ...Array.from({ length: 6 }, (_, i) => ai(`r${i}`))];
    assert.deepEqual(catchUpIndices(long, long.length, settings), [3, 4, 5, 6]);
});

test('a manual edit made while an extraction runs is not overwritten', async () => {
    const viaScheduler = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const running = viaScheduler.conductor.retry();
    await sleep(5);
    await viaScheduler.conductor.editField('location', 'library');
    await running;
    assert.deepEqual([viaScheduler.chat[1].extra.conductor.source, viaScheduler.chat[1].extra.conductor.state.location], ['manual', 'library']);

    const direct = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const observing = direct.conductor.observe(1, new AbortController().signal);
    await sleep(5);
    await direct.conductor.editField('location', 'library');
    await observing;
    assert.equal(direct.chat[1].extra.conductor.state.location, 'library');
});

test('setState refuses a draft from another chat or an older message', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    const view = h.conductor.currentView();
    assert.deepEqual([view.chatId, view.index], ['chat-1', 1]);
    assert.match(view.textHash, /^[0-9a-f]{8}$/);
    h.switchChat('chat-2');
    assert.match((await h.conductor.setState(view.state, { chatId: view.chatId, index: view.index })).error, /chat changed/);
    h.switchChat('chat-1');
    h.chat.push(user('again'), ai('garden'));
    assert.match((await h.conductor.setState(view.state, { chatId: view.chatId, index: view.index })).error, /newer message/);
    assert.equal((await h.conductor.setState(view.state, { chatId: 'chat-1', index: 3 })).ok, true);
});

test('a stale copy of a manual record is labelled scene, not manual', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ fail: true }) });
    h.chat[1].extra = { conductor: makeRecord({ state: validateState({ location: 'library' }).state, source: 'manual' }) };
    await h.conductor.retry();
    const rec = h.chat[1].extra.conductor;
    assert.deepEqual([rec.stale, rec.source, rec.state.location], [true, 'scene', 'library']);
});

test('continue cancels the pending observe for the last message', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'normal');
    h.conductor.onGenerationStarted('continue', {}, false);
    await sleep(40);
    assert.equal(h.scene.calls.length, 0);
});

test('a manual edit on a reply with no record survives the next plan', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const running = h.conductor.retry();
    await sleep(5);
    await h.conductor.editField('location', 'library');
    await running;
    await h.conductor.plan([], 8000, 'normal');
    assert.deepEqual([h.chat[1].extra.conductor.source, h.chat[1].extra.conductor.state.location], ['manual', 'library']);
    assert.match(lastPrompt(h.calls), /Location: library/);
});

test('in commit mode a manual edit is not re-extracted at the next plan', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], overrides: { observeTrigger: 'commit' } });
    await h.conductor.editField('location', 'library');
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 0);
    assert.equal(h.chat[1].extra.conductor.state.location, 'library');
});

test('setState refuses a draft opened on a different swipe of the same message', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    const view = h.conductor.currentView();
    h.chat[1].mes = 'garden';
    const result = await h.conductor.setState(view.state, { chatId: view.chatId, index: view.index, textHash: view.textHash });
    assert.match(result.error, /message changed/);
    assert.equal(h.chat[1].extra.conductor, undefined);
});

test('statusText summarises state', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    assert.match(h.conductor.statusText(), /sangkhem is on\.\nScene: not tracked yet\./);
    await h.conductor.plan([], 8000, 'normal');
    assert.match(h.conductor.statusText(), /Last plan \(\d+ ms\): brief ran/);
    assert.match(h.conductor.statusText(), /Scene: up to date\./);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/conductor.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

`src/conductor.js`:
```js
import { runPhase, FailureTracker } from './runner.js';
import {
    readState, latestAiIndex, previousUserIndex, isAiMessage, makeRecord, writeRecord,
    hashText, isFresh, validateState, applyFieldEdit,
} from './state.js';
import { diffPaths } from './evidence.js';
import { extractStory, parseTagList } from './story.js';
import { applySuppression } from './stages/lore.js';
import { ObserveScheduler } from './observe.js';
import { createStats, recordPlan, recordStageTimes } from './stats.js';

// Most AI replies Plan will observe before one generation: one group turn, not a whole old chat.
export const CATCH_UP_LIMIT = 4;

/** What Observe reads for chat[mesId], and the hash that says whether a record is still current. */
export function observeInput(chat, mesId, settings) {
    const userIndex = previousUserIndex(chat, mesId);
    const userText = userIndex >= 0 ? chat[userIndex].mes ?? '' : '';
    const replyText = extractStory(chat[mesId]?.mes ?? '', parseTagList(settings.stages.scene.storyTags));
    return { userText, replyText, textHash: hashText(`${userText}\n${replyText}`) };
}

/**
 * AI replies in the current run (after the last user message, before `before`) whose record is
 * missing or out of date, oldest first. Stops at the first reply with a current record.
 */
export function catchUpIndices(chat, before, settings, limit = CATCH_UP_LIMIT) {
    const indices = [];
    for (let i = Math.min(before, chat.length) - 1; i >= 0 && indices.length < limit; i--) {
        const message = chat[i];
        if (message?.is_user) break;
        if (!isAiMessage(message)) continue;
        if (isFresh(message.extra?.conductor, observeInput(chat, i, settings).textHash)) break;
        indices.push(i);
    }
    return indices.reverse();
}

function ownManualState(message) {
    const own = message.extra?.conductor;
    if (own?.source !== 'manual') return null;
    const checked = validateState(own.state, { threadsCap: Infinity });
    return checked.ok ? { state: checked.state, record: own } : null;
}

export function createConductor({ deps, stages, suppression, briefStore }) {
    const now = deps.now ?? Date.now;
    const failures = new FailureTracker();
    const session = { lastPlan: null, lastObserve: null, stats: createStats() };
    const scheduler = new ObserveScheduler({
        run: (mesId, signal) => observe(mesId, signal),
        onError: (error) => deps.log?.(error),
    });
    let planController = null;
    const settings = () => deps.getSettings();

    function alert(reports) {
        const threshold = settings().failureToastAfter;
        for (const id of failures.record(reports, threshold)) {
            deps.notify(id, reports.find((r) => r.id === id)?.reason ?? 'failed', threshold);
        }
    }

    function clearBrief() {
        briefStore.value = '';
        deps.setBriefPrompt('', settings().stages.brief.depth);
    }

    async function observe(mesId, signal) {
        const current = settings();
        const chatId = deps.getChatId();
        const chat = deps.getChat();
        const message = chat[mesId];
        if (!isAiMessage(message)) return;
        const input = observeInput(chat, mesId, current);
        const recordAtStart = message.extra?.conductor;
        const base = ownManualState(message) ?? readState(chat, { before: mesId });
        const { userName, charName } = deps.names();
        const result = await runPhase(stages, {
            phase: 'observe',
            turn: {
                chat, mesId, ...input, userName, charName: message.name || charName,
                prevProvenance: base.record?.provenance ?? {}, signal, ctx: deps.getContextView(), settings: current,
            },
            state: base.state,
            settings: current,
            now,
        });

        // Discard results for a chat, message or swipe that is no longer the one we read.
        const live = deps.getChat();
        if (signal.aborted || deps.getChatId() !== chatId || live[mesId] !== message) return;
        if (observeInput(live, mesId, current).textHash !== input.textHash) return;
        // Edited by hand while the model was working: the edit wins.
        if (message.extra?.conductor !== recordAtStart) return;

        session.lastObserve = { at: now(), mesId, reports: result.reports, scene: result.outputs.scene ?? null };
        recordStageTimes(session.stats, result.reports);
        alert(result.reports);
        const scene = result.reports.find((r) => r.id === 'scene');
        if (scene?.status === 'ran') {
            writeRecord(message, makeRecord({
                state: result.state, provenance: result.outputs.scene?.provenance ?? {}, source: 'scene', textHash: input.textHash,
            }));
        } else if (scene?.status === 'failed') {
            // Labelled 'scene' even when copied from a manual record: it is not a new edit by the user.
            writeRecord(message, makeRecord({
                state: base.state, provenance: base.record?.provenance ?? {}, source: 'scene',
                stale: true, textHash: input.textHash,
            }));
        } else {
            deps.onUpdate();
            return;
        }
        await deps.saveChat();
        deps.onUpdate();
    }

    // Observes every reply of the current run that is not up to date, oldest first (the scheduler
    // runs them in order), and waits up to observeWaitMs for the last one.
    async function ensureObserved(chat, before, current) {
        if (current.stages.scene?.enabled === false) return;
        const indices = catchUpIndices(chat, before, current);
        if (!indices.length) return;
        for (const index of indices) scheduler.start(index);
        await scheduler.flush(indices.at(-1), current.observeWaitMs);
    }

    async function plan(coreChat, contextSize, rawType) {
        const type = rawType || 'normal';
        const current = settings();
        if (type === 'quiet') return;
        if (!current.enabled) {
            suppression.clear();
            clearBrief();
            return;
        }
        if (type === 'continue') return;

        planController?.abort();
        const controller = new AbortController();
        planController = controller;
        suppression.clear();
        clearBrief();
        const started = now();
        const chatId = deps.getChatId();
        const chat = deps.getChat();
        // A swipe replaces the last AI message, so its state must not feed the new reply.
        const before = type === 'swipe' && isAiMessage(chat[chat.length - 1]) ? chat.length - 1 : chat.length;

        await ensureObserved(chat, before, current);
        const { state } = readState(chat, { before });
        const result = await runPhase(stages, {
            phase: 'plan',
            turn: { chat: coreChat, contextSize, type, signal: controller.signal, ctx: deps.getContextView(), settings: current },
            state,
            settings: current,
            budgetMs: Math.max(0, current.planBudgetMs - (now() - started)),
            now,
        });
        if (planController === controller) planController = null;
        if (deps.getChatId() !== chatId) {
            suppression.clear();
            clearBrief();
            return;
        }

        const brief = result.outputs.brief?.brief ?? '';
        const briefTokens = brief ? await deps.countTokens(brief) : 0;
        const ms = now() - started;
        const droppedTokens = result.outputs.lore?.droppedTokens ?? 0;
        session.lastPlan = { at: now(), type, ms, reports: result.reports, brief, briefTokens, droppedTokens };
        recordPlan(session.stats, { ms, reports: result.reports, briefTokens, droppedTokens });
        alert(result.reports);
        deps.onUpdate();
    }

    function onMessageReceived(mesId, type) {
        const current = settings();
        if (!current.enabled || current.observeTrigger !== 'settled' || type === 'quiet' || type === 'impersonate') return;
        const id = Number(mesId);
        if (isAiMessage(deps.getChat()[id])) scheduler.schedule(id, current.settleMs);
    }

    function onMessageEdited(mesId) {
        const current = settings();
        if (!current.enabled || current.observeTrigger !== 'settled') return;
        const chat = deps.getChat();
        const id = Number(mesId);
        const target = isAiMessage(chat[id]) ? id : chat[id]?.is_user && isAiMessage(chat[id + 1]) ? id + 1 : -1;
        if (target >= 0) scheduler.schedule(target, current.settleMs);
    }

    function onMessageSwiped(mesId) {
        scheduler.cancel(Number(mesId));
        deps.onUpdate();
    }

    function onMessageDeleted() {
        scheduler.cancelAll();
        deps.onUpdate();
    }

    // The last message is about to change (new swipe, regenerated, or continued), so an observe of
    // its current text would be wasted.
    function onGenerationStarted(type, _options, dryRun) {
        if (dryRun || !['swipe', 'regenerate', 'continue'].includes(type)) return;
        scheduler.cancel(deps.getChat().length - 1);
    }

    function onGenerationStopped() {
        planController?.abort();
        suppression.clear();
    }

    function onGenerationEnded() {
        suppression.clear();
    }

    function onChatChanged() {
        planController?.abort();
        scheduler.cancelAll();
        suppression.clear();
        clearBrief();
        session.lastPlan = null;
        session.lastObserve = null;
        deps.onUpdate();
    }

    const onWorldInfoLoaded = (data) => applySuppression(data, suppression);

    function currentView() {
        const chat = deps.getChat();
        const index = latestAiIndex(chat);
        const own = index >= 0 ? chat[index].extra?.conductor ?? null : null;
        const { state, record, index: stateIndex } = readState(chat);
        return {
            chatId: deps.getChatId(), index, stateIndex, state,
            textHash: index >= 0 ? observeInput(chat, index, settings()).textHash : null,
            provenance: record?.provenance ?? {},
            stale: Boolean(own?.stale),
            observed: Boolean(own?.state),
            pending: index >= 0 && scheduler.isPending(index),
        };
    }

    /**
     * Saves a manual edit onto the latest AI message. `expected` ({ chatId, index, textHash } from the
     * view the edit started from) refuses the save if the chat, the latest message, or that message's
     * text (swipe, regenerate, edit) changed since. The record is stamped with the message's current
     * text hash, so Plan treats it as current and never re-extracts over the edit.
     */
    async function setState(raw, expected = {}) {
        const checked = validateState(raw, { threadsCap: settings().stages.scene.threadsCap });
        if (!checked.ok) return { ok: false, error: checked.error };
        const chat = deps.getChat();
        const index = latestAiIndex(chat);
        if (index < 0) return { ok: false, error: 'no character message to attach the scene to yet' };
        if ('chatId' in expected && expected.chatId !== deps.getChatId()) {
            return { ok: false, error: 'the chat changed since you started editing, so the edit was not saved' };
        }
        if ('index' in expected && expected.index !== index) {
            return { ok: false, error: 'a newer message arrived since you started editing, so the edit was not saved' };
        }
        const { textHash } = observeInput(chat, index, settings());
        if ('textHash' in expected && expected.textHash !== textHash) {
            return { ok: false, error: 'the message changed since you started editing (swiped, regenerated or edited), so the edit was not saved' };
        }
        scheduler.cancel(index); // an extraction in flight must not overwrite the edit
        const { state: prev, record } = readState(chat);
        const provenance = { ...(record?.provenance ?? {}) };
        for (const path of diffPaths(prev, checked.state)) provenance[path] = { mesId: null, quote: null, manual: true };
        writeRecord(chat[index], makeRecord({
            state: checked.state, provenance, source: 'manual', textHash,
        }));
        await deps.saveChat();
        deps.onUpdate();
        return { ok: true, state: checked.state };
    }

    async function editField(path, value) {
        if (latestAiIndex(deps.getChat()) < 0) return { ok: false, error: 'no character message to attach the scene to yet' };
        const edit = applyFieldEdit(currentView().state, path, value);
        return edit.ok ? setState(edit.state) : edit;
    }

    async function retry() {
        const index = latestAiIndex(deps.getChat());
        if (index < 0) return;
        scheduler.cancel(index);
        await scheduler.start(index);
    }

    function statusText() {
        const lines = [`sangkhem is ${settings().enabled ? 'on' : 'off'}.`];
        if (session.lastPlan) {
            lines.push(`Last plan (${session.lastPlan.ms} ms): ${session.lastPlan.reports.map((r) => `${r.id} ${r.status}`).join(', ')}`);
        }
        const view = currentView();
        lines.push(view.stale ? 'Scene: out of date (last extraction failed).' : view.observed ? 'Scene: up to date.' : 'Scene: not tracked yet.');
        return lines.join('\n');
    }

    return {
        plan, observe, clearBrief, currentView, setState, editField, retry, statusText, session,
        onMessageReceived, onMessageEdited, onMessageSwiped, onMessageDeleted,
        onGenerationStarted, onGenerationStopped, onGenerationEnded, onChatChanged, onWorldInfoLoaded,
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/conductor.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS, every test so far.

- [ ] **Step 6: Commit**

```bash
git add src/conductor.js tests/conductor.test.js
git commit -m "feat: add conductor orchestrating plan and observe phases"
```

---

### Task 13: SillyTavern adapter, commands and entry point

**Files:**
- Create: `src/st.js`, `src/commands.js`, `index.js`, `style.css` (placeholder, filled in Task 14)
- Test: `tests/imports.test.js`

**Interfaces:**
- Consumes: everything above; `initPanel`, `refreshPanel` from `src/ui/panel.js` (Task 14 — until then, `index.js` imports a stub created in Step 3).
- Produces (`src/st.js`): `ctx()`, `initSettings()`, `getSettings()`, `saveSettings()`, `getChat()`, `getChatId()`, `getContextView() → { extensionSettings, chatMetadata, disabledExtensions }`, `names() → { userName, charName }`, `saveChat() → Promise`, `setBriefPrompt(text, depth)`, `countTokens(text) → Promise<number>`, `scanWorldInfo(chatForWI, contextSize) → Promise<entry[]>`, `worldInfoIncludeNames() → Promise<boolean>`, `sendLlmRequest(profileId, messages, { maxTokens, temperature, signal }) → Promise` (no sampler preset; explicit temperature), `listProfiles() → [{ id, name }]`, `registerBriefMacro(briefStore)`, `presetPromptTexts() → string[]`, `currentSource() → string`, `currentModel() → string`.
- Produces (`src/commands.js`): `registerCommands({ conductor, refresh })` adding `/conductor` and `/scene`.

- [ ] **Step 1: Write the failing imports test**

`tests/imports.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
// The only files allowed to touch SillyTavern or the DOM.
const ST_FILES = new Set([
    'index.js', 'src/st.js', 'src/commands.js',
    'src/ui/dom.js', 'src/ui/panel.js', 'src/ui/settingsForm.js', 'src/ui/scenePanel.js', 'src/ui/inspector.js',
]);

function jsFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? jsFiles(path) : path.endsWith('.js') ? [path] : [];
    });
}

const sources = jsFiles(join(root, 'src')).map((path) => relative(root, path));

test('logic modules never reference SillyTavern or browser globals', () => {
    const offenders = sources
        .filter((file) => !ST_FILES.has(file))
        .filter((file) => /\b(SillyTavern|document|window|toastr|jQuery)\b/.test(readFileSync(join(root, file), 'utf8')));
    assert.deepEqual(offenders, []);
});

test('every src module imports in plain Node', async () => {
    for (const file of sources) {
        await import(join(root, file));
    }
});
```

- [ ] **Step 2: Run test to verify it fails or passes as expected**

Run: `node --test tests/imports.test.js`
Expected: PASS for existing modules. (It guards the new files added below; it will FAIL if `st.js` or `commands.js` touch globals at import time.)

- [ ] **Step 3: Write `src/st.js`**

```js
// The SillyTavern adapter. Everything else is plain logic, testable in Node.
// Nothing here may touch SillyTavern at import time.
import { MODULE_NAME, mergeDefaults } from './settings.js';

export const ctx = () => SillyTavern.getContext();

// extension_prompt_types.IN_CHAT and extension_prompt_roles.SYSTEM in public/script.js.
const IN_CHAT = 1;
const SYSTEM_ROLE = 0;

export function initSettings() {
    const root = ctx().extensionSettings;
    root[MODULE_NAME] = mergeDefaults(root[MODULE_NAME]);
    return root[MODULE_NAME];
}

export const getSettings = () => ctx().extensionSettings[MODULE_NAME];
export const saveSettings = () => ctx().saveSettingsDebounced();
export const getChat = () => ctx().chat;
export const getChatId = () => ctx().getCurrentChatId?.();
export const saveChat = () => ctx().saveChat();

export function getContextView() {
    const c = ctx();
    return {
        extensionSettings: c.extensionSettings,
        chatMetadata: c.chatMetadata,
        disabledExtensions: c.extensionSettings?.disabledExtensions ?? [],
    };
}

export function names() {
    const c = ctx();
    return { userName: c.name1 || 'User', charName: c.name2 || 'Character' };
}

export function setBriefPrompt(text, depth) {
    ctx().setExtensionPrompt(MODULE_NAME, text, IN_CHAT, depth, false, SYSTEM_ROLE);
}

export async function countTokens(text) {
    try {
        return await ctx().getTokenCountAsync(text);
    } catch {
        return Math.ceil(String(text ?? '').length / 4);
    }
}

let worldInfoModule;
async function worldInfo() {
    worldInfoModule ??= await import('../../../../world-info.js');
    return worldInfoModule;
}

/** Dry-run World Info scan with ST's own matcher. */
export async function scanWorldInfo(chatForWI, contextSize) {
    const scan = await (await worldInfo()).checkWorldInfo(chatForWI, contextSize, true);
    return Array.from(scan?.allActivatedEntries?.values?.() ?? []);
}

/** ST's World Info "Include names" setting, so the dry run scans the same text as the real scan. */
export async function worldInfoIncludeNames() {
    return Boolean((await worldInfo()).world_info_include_names);
}

// The profile's sampler preset is not applied (includePreset: false) and the temperature is sent
// explicitly, so the extension runs the same settings tools/eval-scene.mjs measures.
export function sendLlmRequest(profileId, messages, { maxTokens, temperature, signal }) {
    return ctx().ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        { stream: false, signal, extractData: true, includePreset: false, includeInstruct: true },
        temperature === undefined ? {} : { temperature },
    );
}

export function listProfiles() {
    try {
        return ctx().ConnectionManagerRequestService.getSupportedProfiles().map((p) => ({ id: p.id, name: p.name }));
    } catch {
        return [];
    }
}

// Registers {{conductor_brief}} in both macro engines. The legacy registry serves SillyTavern's default
// engine and bridges into the new engine itself when that engine is on at startup; registering in the new
// engine as well covers a user who turns it on later.
export function registerBriefMacro(briefStore) {
    const c = ctx();
    const handler = () => briefStore.value;
    const description = 'sangkhem scene notes for this turn';
    c.registerMacro('conductor_brief', handler, description);
    if (c.macros?.register && !c.macros.registry?.hasMacro?.('conductor_brief')) {
        c.macros.register('conductor_brief', { description, handler });
    }
}

export function presetPromptTexts() {
    const prompts = ctx().chatCompletionSettings?.prompts;
    return Array.isArray(prompts) ? prompts.map((p) => p?.content) : [];
}

export const currentSource = () => ctx().chatCompletionSettings?.chat_completion_source ?? '';

export function currentModel() {
    try {
        return ctx().getChatCompletionModel() ?? '';
    } catch {
        return '';
    }
}
```

- [ ] **Step 4: Write `src/commands.js`**

```js
import { ctx, getSettings, saveSettings } from './st.js';
import { parseSceneSet } from './state.js';
import { renderSceneLines } from './stages/brief.js';

const sceneText = (state) => renderSceneLines(state).join('\n') || 'No scene state yet.';

export function registerCommands({ conductor, refresh }) {
    const c = ctx();
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'conductor',
        helpString: 'sangkhem: <code>/conductor on</code>, <code>/conductor off</code>, or <code>/conductor status</code> (default).',
        returns: 'status text',
        unnamedArgumentList: [
            c.SlashCommandArgument.fromProps({
                description: 'on, off, or status',
                typeList: [c.ARGUMENT_TYPE.STRING],
                enumList: ['on', 'off', 'status'],
                defaultValue: 'status',
            }),
        ],
        callback: (_named, value) => {
            const arg = String(value || 'status').trim().toLowerCase();
            if (arg === 'on' || arg === 'off') {
                getSettings().enabled = arg === 'on';
                if (arg === 'off') conductor.clearBrief();
                saveSettings();
                refresh();
            } else if (arg !== 'status') {
                toastr.warning(`Unknown /conductor argument "${arg}". Use on, off, or status.`, 'sangkhem', { escapeHtml: true });
            }
            const text = conductor.statusText();
            toastr.info(text.replaceAll('\n', '<br>'), 'sangkhem', { escapeHtml: false });
            return text;
        },
    }));
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'scene',
        helpString: 'sangkhem scene state. <code>/scene</code> prints it. <code>/scene set location=rooftop</code> edits it. '
            + 'Paths: location, time, threads (separate with ;), present.&lt;Name&gt;.outfit|condition|mood, present.&lt;Name&gt;= (empty removes).',
        returns: 'scene state text',
        unnamedArgumentList: [
            c.SlashCommandArgument.fromProps({
                description: 'empty, or: set <path>=<value>',
                typeList: [c.ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
        ],
        callback: async (_named, value) => {
            const arg = String(value ?? '').trim();
            if (/^set\s/i.test(arg)) {
                const parsed = parseSceneSet(arg.replace(/^set\s+/i, ''));
                if (!parsed) {
                    toastr.warning('Use /scene set <path>=<value>, for example /scene set location=rooftop.', 'sangkhem');
                    return '';
                }
                const result = await conductor.editField(parsed.path, parsed.value);
                if (!result.ok) {
                    toastr.warning(result.error, 'sangkhem', { escapeHtml: true });
                    return '';
                }
            } else if (arg) {
                toastr.warning('Use /scene, or /scene set <path>=<value>.', 'sangkhem');
                return '';
            }
            return sceneText(conductor.currentView().state);
        },
    }));
}
```

`toastr.info(..., { escapeHtml: false })` receives only `statusText()`, which is built from stage ids, statuses and numbers — no chat or model text. Keep it that way.

- [ ] **Step 5: Write `index.js` and a temporary panel stub**

`src/ui/panel.js` (stub, replaced in Task 14):
```js
export async function initPanel() {}
export function refreshPanel() {}
```

`style.css`:
```css
/* Filled in Task 14. */
```

`index.js`:
```js
import { LOG_PREFIX } from './src/settings.js';
import * as st from './src/st.js';
import { createLlm } from './src/llm.js';
import { createConductor } from './src/conductor.js';
import { createMemoryStage } from './src/stages/memory.js';
import { createLoreStage } from './src/stages/lore.js';
import { createBriefStage } from './src/stages/brief.js';
import { createSceneStage } from './src/stages/scene.js';
import { createLayaScorer } from './src/backends/scorers/laya.js';
import { noneScorer } from './src/backends/scorers/none.js';
import { initPanel, refreshPanel } from './src/ui/panel.js';
import { registerCommands } from './src/commands.js';

const suppression = new Set();
const briefStore = { value: '' };
const laya = createLayaScorer();

const stages = [
    createMemoryStage(),
    createLoreStage({
        scorers: { laya, none: noneScorer },
        scanWorldInfo: st.scanWorldInfo,
        countTokens: st.countTokens,
        includeNames: st.worldInfoIncludeNames,
        suppression,
    }),
    createBriefStage({ briefStore, setPrompt: st.setBriefPrompt }),
    createSceneStage({ llm: createLlm(st.sendLlmRequest) }),
];

const conductor = createConductor({
    stages,
    suppression,
    briefStore,
    deps: {
        getSettings: st.getSettings,
        getChat: st.getChat,
        getChatId: st.getChatId,
        getContextView: st.getContextView,
        names: st.names,
        saveChat: st.saveChat,
        setBriefPrompt: st.setBriefPrompt,
        countTokens: st.countTokens,
        // `reason` can carry model or proxy text, so the toast is always escaped.
        notify: (id, reason, count) => toastr.warning(
            `The ${id} stage failed ${count} turns in a row (${reason}). Replies still generate without it.`,
            'sangkhem', { escapeHtml: true }),
        onUpdate: () => refreshPanel(),
        log: (error) => console.error(`${LOG_PREFIX} observe failed`, error),
    },
});

// Runs before ST's real World Info scan. Must never throw: generation continues regardless.
globalThis.conductorInterceptor = async function (chat, contextSize, _abort, type) {
    try {
        await conductor.plan(chat, contextSize, type);
    } catch (error) {
        suppression.clear();
        console.error(`${LOG_PREFIX} plan failed; generation continues unchanged`, error);
    }
};

// The conductor's handlers are synchronous (Observe runs on its own timer), so ST's awaited
// event chain is never held up. A handler error is logged, never thrown into ST.
function safe(name, fn) {
    return (...args) => {
        try {
            fn(...args);
        } catch (error) {
            console.error(`${LOG_PREFIX} ${name} handler failed`, error);
        }
    };
}

function registerEvents() {
    const { eventSource, eventTypes } = st.ctx();
    eventSource.on(eventTypes.MESSAGE_RECEIVED, safe('MESSAGE_RECEIVED', conductor.onMessageReceived));
    eventSource.on(eventTypes.MESSAGE_EDITED, safe('MESSAGE_EDITED', conductor.onMessageEdited));
    eventSource.on(eventTypes.MESSAGE_SWIPED, safe('MESSAGE_SWIPED', conductor.onMessageSwiped));
    eventSource.on(eventTypes.MESSAGE_DELETED, safe('MESSAGE_DELETED', conductor.onMessageDeleted));
    eventSource.on(eventTypes.GENERATION_STARTED, safe('GENERATION_STARTED', conductor.onGenerationStarted));
    eventSource.on(eventTypes.GENERATION_STOPPED, safe('GENERATION_STOPPED', conductor.onGenerationStopped));
    eventSource.on(eventTypes.GENERATION_ENDED, safe('GENERATION_ENDED', conductor.onGenerationEnded));
    eventSource.on(eventTypes.CHAT_CHANGED, safe('CHAT_CHANGED', conductor.onChatChanged));
    eventSource.on(eventTypes.WORLDINFO_ENTRIES_LOADED, safe('WORLDINFO_ENTRIES_LOADED', conductor.onWorldInfoLoaded));
}

jQuery(async () => {
    st.initSettings();
    st.registerBriefMacro(briefStore);
    registerEvents();
    registerCommands({ conductor, refresh: refreshPanel });
    await initPanel({ conductor, stages, laya });
});
```

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS, including both imports tests.

- [ ] **Step 7: Install into SillyTavern and smoke-test loading**

Run:
```bash
ln -s /Users/westin/Desktop/sangkhem /Users/westin/SillyTavern-Launcher/SillyTavern/data/default-user/extensions/sangkhem
```
Start SillyTavern, open the browser console, reload. Expected: no `[sangkhem]` errors; `typeof globalThis.conductorInterceptor === 'function'`; `/conductor status` prints `sangkhem is on.` and `Scene: not tracked yet.`; sending a message still produces a normal reply.

- [ ] **Step 8: Commit**

```bash
git add src/st.js src/commands.js src/ui/panel.js index.js style.css tests/imports.test.js
git commit -m "feat: wire conductor into SillyTavern with commands"
```

---

### Task 14: Settings panel, scene panel and turn inspector

**Files:**
- Create: `settings.html`, `src/ui/dom.js`, `src/ui/format.js`, `src/ui/settingsForm.js`, `src/ui/scenePanel.js`, `src/ui/inspector.js`
- Modify: `src/ui/panel.js` (replace stub), `style.css`
- Test: `tests/dom.test.js`, `tests/format.test.js`

**Interfaces:**
- Consumes: `describeStage` (Task 2), `summarizeStats` (Task 11), `PERSON_ATTRS` (Task 3), `st.js` getters (Task 13), `conductor.currentView/setState/retry/session` (Task 12), `laya.health` (Task 9).
- Produces:
  - `h(tag, props = {}, children = [], doc = globalThis.document) → Element` — text only via `textContent`/text nodes. Supported props: `class`, `text`, `value`, `checked`, `type`, `title`, `placeholder`, `rows`, `data-*`, `on<event>`. Anything else throws.
  - `format.js`: `reportLine(report)`, `statsLines(summary)`, `briefDoubleWarning(mode, promptTexts)`, `cacheHint({ source, model, protectCachePrefix })`, `provenanceText(entry)`.
  - `panel.js`: `initPanel({ conductor, stages, laya })`, `refreshPanel()`. A scene draft remembers the chat id, message index and message text hash it was opened for; a draft for another chat, an older message, or another swipe is dropped on refresh and refused on save.

- [ ] **Step 1: Write the failing tests**

`tests/dom.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/ui/dom.js';

class FakeNode {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.attrs = {};
        this.listeners = {};
        this.ownText = '';
    }
    set innerHTML(_value) { throw new Error('innerHTML must never be used'); }
    set textContent(value) { this.ownText = value; }
    get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    append(...nodes) { this.children.push(...nodes); }
}
const doc = { createElement: (tag) => new FakeNode(tag), createTextNode: (text) => ({ textContent: text, isText: true }) };

test('markup in text stays literal text', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const node = h('div', { text: payload }, [payload], doc);
    assert.equal(node.ownText, payload);
    assert.equal(node.children[0].isText, true);
    assert.equal(node.textContent, payload + payload);
});

test('supports the listed props', () => {
    const onclick = () => {};
    const node = h('input', { class: 'a b', value: 'v', checked: true, type: 'text', 'data-x': 1, rows: 3, onclick }, [], doc);
    assert.equal(node.className, 'a b');
    assert.equal(node.value, 'v');
    assert.equal(node.checked, true);
    assert.deepEqual(node.attrs, { type: 'text', 'data-x': '1', rows: '3' });
    assert.equal(node.listeners.click, onclick);
});

test('skips null children and rejects unknown props', () => {
    assert.equal(h('div', {}, [null, false, 'x'], doc).children.length, 1);
    assert.throws(() => h('div', { innerHTML: '<b>' }, [], doc), /unsupported prop "innerHTML"/);
    assert.throws(() => h('div', { style: 'x' }, [], doc), /unsupported prop/);
});
```

`tests/format.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportLine, statsLines, briefDoubleWarning, cacheHint, provenanceText } from '../src/ui/format.js';

test('reportLine', () => {
    assert.equal(reportLine({ id: 'lore', status: 'ran', ms: 812, summary: 'kept 6' }), 'lore: ran, 812 ms — kept 6');
    assert.equal(reportLine({ id: 'memory', status: 'skipped', ms: 0, reason: 'not installed' }), 'memory: skipped — not installed');
    assert.equal(reportLine({ id: 'brief', status: 'off', ms: 0 }), 'brief: off');
});

test('statsLines', () => {
    assert.deepEqual(statsLines({ turns: 0 }), ['No turns yet this session.']);
    const lines = statsLines({ turns: 3, plan: { p50: 40, p95: 900 }, stages: { lore: { n: 3, p50: 30, p95: 800 } }, avgBriefTokens: 50, avgDroppedTokens: 400 });
    assert.deepEqual(lines, [
        '3 turn(s). Plan time p50 40 ms, p95 900 ms.',
        'lore: p50 30 ms, p95 800 ms (3 runs)',
        'Brief adds ~50 tokens per turn; lore pruning removes ~400.',
    ]);
});

test('briefDoubleWarning only in auto mode with the macro in the preset', () => {
    assert.match(briefDoubleWarning('auto', ['x', 'a {{conductor_brief}} b']), /sent twice/);
    assert.equal(briefDoubleWarning('macro', ['{{conductor_brief}}']), null);
    assert.equal(briefDoubleWarning('auto', ['x', null]), null);
});

test('cacheHint for Claude when the prefix is not protected', () => {
    assert.match(cacheHint({ source: 'claude', model: '', protectCachePrefix: false }), /Protect cache prefix/);
    assert.match(cacheHint({ source: 'custom', model: 'cc/claude-opus-4-6', protectCachePrefix: false }), /Protect cache prefix/);
    assert.equal(cacheHint({ source: 'claude', model: '', protectCachePrefix: true }), null);
    assert.equal(cacheHint({ source: 'openrouter', model: 'google/gemini-2.5-pro', protectCachePrefix: false }), null);
});

test('provenanceText', () => {
    assert.equal(provenanceText({ mesId: 12, quote: 'onto the roof' }), 'message #12: "onto the roof"');
    assert.equal(provenanceText({ manual: true, mesId: null, quote: null }), 'set by hand');
    assert.equal(provenanceText(undefined), '');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/dom.test.js tests/format.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `src/ui/dom.js` and `src/ui/format.js`**

`src/ui/dom.js`:
```js
const ATTRIBUTES = new Set(['type', 'title', 'placeholder', 'rows', 'min', 'max', 'step']);

/**
 * Builds an element. Text goes through textContent or text nodes only, so chat and model text can
 * never inject markup. Unknown props throw rather than being set silently.
 */
export function h(tag, props = {}, children = [], doc = globalThis.document) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'value') node.value = value;
        else if (key === 'checked') node.checked = Boolean(value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (key.startsWith('data-') || ATTRIBUTES.has(key)) node.setAttribute(key, String(value));
        else throw new Error(`h(): unsupported prop "${key}"`);
    }
    for (const child of [].concat(children)) {
        if (child == null || child === false) continue;
        node.append(typeof child === 'string' || typeof child === 'number' ? doc.createTextNode(String(child)) : child);
    }
    return node;
}
```

`src/ui/format.js`:
```js
export function reportLine(report) {
    const ms = report.status === 'ran' || report.status === 'failed' ? `, ${report.ms} ms` : '';
    const detail = report.summary ?? report.reason ?? '';
    return `${report.id}: ${report.status}${ms}${detail ? ` — ${detail}` : ''}`;
}

export function statsLines(summary) {
    if (!summary.turns) return ['No turns yet this session.'];
    return [
        `${summary.turns} turn(s). Plan time p50 ${summary.plan.p50} ms, p95 ${summary.plan.p95} ms.`,
        ...Object.entries(summary.stages).map(([id, s]) => `${id}: p50 ${s.p50} ms, p95 ${s.p95} ms (${s.n} runs)`),
        `Brief adds ~${summary.avgBriefTokens} tokens per turn; lore pruning removes ~${summary.avgDroppedTokens}.`,
    ];
}

export function briefDoubleWarning(mode, promptTexts) {
    if (mode !== 'auto') return null;
    const used = promptTexts.some((text) => typeof text === 'string' && text.includes('{{conductor_brief}}'));
    return used ? 'Your preset uses {{conductor_brief}} and auto-inject is on, so the brief is sent twice. Switch the brief to macro mode.' : null;
}

export function cacheHint({ source, model, protectCachePrefix }) {
    if (protectCachePrefix) return null;
    const claude = source === 'claude' || /claude|anthropic/i.test(model ?? '');
    return claude ? 'If you use prompt caching with Claude, turn on "Protect cache prefix" so lore pruning does not break the cache.' : null;
}

export function provenanceText(entry) {
    if (!entry) return '';
    if (entry.manual) return 'set by hand';
    return `message #${entry.mesId}: "${entry.quote}"`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/dom.test.js tests/format.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Write `settings.html`**

```html
<div id="sangkhem-settings" class="sangkhem-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>sangkhem</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" data-sk-setting="enabled"> Enable conductor</label>
            <div id="sangkhem-warnings"></div>

            <h4>Stages</h4>
            <div id="sangkhem-stage-status"></div>

            <h4>Scene</h4>
            <div id="sangkhem-scene-panel"></div>

            <h4>Last turn</h4>
            <div id="sangkhem-inspector"></div>

            <details class="sk-settings">
                <summary>Settings</summary>

                <h5>General</h5>
                <label>Plan budget (ms) <input class="text_pole" type="number" min="0" data-sk-setting="planBudgetMs"></label>
                <label>Observe
                    <select class="text_pole" data-sk-setting="observeTrigger">
                        <option value="settled">after each reply settles (no delay before replies)</option>
                        <option value="commit">when I send my next message (fewer calls, adds delay)</option>
                    </select>
                </label>
                <label>Settle delay (ms) <input class="text_pole" type="number" min="0" data-sk-setting="settleMs"></label>
                <label>Wait for scene tracking before a reply (ms) <input class="text_pole" type="number" min="0" data-sk-setting="observeWaitMs"></label>
                <label>Warn after this many failures in a row <input class="text_pole" type="number" min="1" data-sk-setting="failureToastAfter"></label>

                <h5>Memory</h5>
                <label class="checkbox_label"><input type="checkbox" data-sk-setting="stages.memory.enabled"> Enabled</label>
                <label>Source
                    <select class="text_pole" data-sk-setting="stages.memory.backend">
                        <option value="summaryception">Summaryception</option>
                        <option value="none">None</option>
                    </select>
                </label>

                <h5>Lore</h5>
                <label class="checkbox_label"><input type="checkbox" data-sk-setting="stages.lore.enabled"> Enabled</label>
                <label>Scorer
                    <select class="text_pole" data-sk-setting="stages.lore.backend">
                        <option value="laya">Laya (local service)</option>
                        <option value="none">None</option>
                    </select>
                </label>
                <label>Service URL <input class="text_pole" type="text" data-sk-setting="stages.lore.serviceUrl"></label>
                <button id="sangkhem-lore-test" class="menu_button" type="button">Test connection</button>
                <label>Timeout (ms) <input class="text_pole" type="number" min="0" data-sk-setting="stages.lore.timeoutMs"></label>
                <label>Max candidates scored <input class="text_pole" type="number" min="1" data-sk-setting="stages.lore.maxCandidates"></label>
                <label>Token budget for kept entries <input class="text_pole" type="number" min="0" data-sk-setting="stages.lore.budgetTokens"></label>
                <label>Recent turns sent to the scorer <input class="text_pole" type="number" min="1" data-sk-setting="stages.lore.recentTurns"></label>
                <label>Relevance weight <input class="text_pole" type="number" step="0.1" data-sk-setting="stages.lore.wRelevance"></label>
                <label>Usefulness weight <input class="text_pole" type="number" step="0.1" data-sk-setting="stages.lore.wUsefulness"></label>
                <label>Minimum score to keep <input class="text_pole" type="number" step="0.1" data-sk-setting="stages.lore.minScore"></label>
                <label class="checkbox_label"><input type="checkbox" data-sk-setting="stages.lore.protectCachePrefix"> Protect cache prefix (only judge @depth entries)</label>

                <h5>Brief</h5>
                <label class="checkbox_label"><input type="checkbox" data-sk-setting="stages.brief.enabled"> Enabled</label>
                <label>Placement
                    <select class="text_pole" data-sk-setting="stages.brief.mode">
                        <option value="auto">Auto-inject in chat</option>
                        <option value="macro">Only via {{conductor_brief}}</option>
                    </select>
                </label>
                <label>Chat depth <input class="text_pole" type="number" min="0" data-sk-setting="stages.brief.depth"></label>
                <label>Template ({{scene}} is replaced) <textarea class="text_pole" rows="5" data-sk-setting="stages.brief.template"></textarea></label>

                <h5>Scene tracking</h5>
                <label class="checkbox_label"><input type="checkbox" data-sk-setting="stages.scene.enabled"> Enabled</label>
                <label>Connection profile (pick a small or free model)
                    <select class="text_pole" data-sk-setting="stages.scene.profileId"></select>
                </label>
                <label>Timeout (ms) <input class="text_pole" type="number" min="0" data-sk-setting="stages.scene.timeoutMs"></label>
                <label>Max reply tokens <input class="text_pole" type="number" min="100" data-sk-setting="stages.scene.maxTokens"></label>
                <label>Temperature (also used by the eval tool) <input class="text_pole" type="number" min="0" max="2" step="0.1" data-sk-setting="stages.scene.temperature"></label>
                <label>Max open threads <input class="text_pole" type="number" min="1" data-sk-setting="stages.scene.threadsCap"></label>
                <label>Story tags (comma separated) <input class="text_pole" type="text" data-sk-setting="stages.scene.storyTags"></label>
                <label class="checkbox_label"><input type="checkbox" data-sk-setting="stages.scene.fields.location"> Track location</label>
                <label class="checkbox_label"><input type="checkbox" data-sk-setting="stages.scene.fields.time"> Track time</label>
                <label class="checkbox_label"><input type="checkbox" data-sk-setting="stages.scene.fields.present"> Track who is present</label>
                <label class="checkbox_label"><input type="checkbox" data-sk-setting="stages.scene.fields.threads"> Track open threads</label>
            </details>
        </div>
    </div>
</div>
```

- [ ] **Step 6: Write the UI modules**

`src/ui/settingsForm.js`:
```js
import { getPath, setPath } from '../settings.js';
import { getSettings, saveSettings, listProfiles } from '../st.js';

/** Loads settings.html (a static file shipped with the extension) into ST's extensions panel. */
export async function mountSettings() {
    const html = await (await fetch(new URL('../../settings.html', import.meta.url))).text();
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const root = template.content.firstElementChild;
    (document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings')).append(root);
    return root;
}

function readInput(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') {
        const n = Number(el.value);
        return el.value !== '' && Number.isFinite(n) ? n : null;
    }
    return el.value;
}

function writeInput(el, value) {
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';
}

export function bindSettings(root, onChange) {
    for (const el of root.querySelectorAll('[data-sk-setting]')) {
        writeInput(el, getPath(getSettings(), el.dataset.skSetting));
        el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
            const value = readInput(el);
            if (value === null) return;
            setPath(getSettings(), el.dataset.skSetting, value);
            saveSettings();
            onChange();
        });
    }
}

export function fillProfiles(root) {
    const select = root.querySelector('[data-sk-setting="stages.scene.profileId"]');
    const current = getSettings().stages.scene.profileId;
    const options = [['', '(choose a profile)'], ...listProfiles().map((p) => [p.id, p.name])];
    if (current && !options.some(([id]) => id === current)) options.push([current, '(missing profile)']);
    select.replaceChildren(...options.map(([id, name]) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        return option;
    }));
    select.value = current;
}
```

`src/ui/scenePanel.js`:
```js
import { h } from './dom.js';
import { provenanceText } from './format.js';
import { PERSON_ATTRS } from '../state.js';

const LABELS = { location: 'Location', time: 'Time' };

/**
 * Editable scene state. Edits stay in a draft until Save; onDirty tells the caller not to re-render
 * over unsaved edits.
 */
export function renderScenePanel(container, { view, fields, onDirty, onSave, onRevert, onRetry, onJump }) {
    if (view.index < 0) {
        container.replaceChildren(h('div', { class: 'sk-muted', text: 'No character message yet.' }));
        return;
    }
    const draft = structuredClone(view.state);
    const on = (field) => fields?.[field] !== false;
    const edit = (apply) => (event) => { apply(event.target.value); onDirty(); };
    const rows = [];

    if (view.stale) {
        rows.push(h('div', { class: 'sk-stale' }, [
            'Out of date: the last extraction failed. ',
            h('button', { class: 'menu_button', type: 'button', onclick: onRetry }, 'Retry'),
        ]));
    }
    if (view.pending) rows.push(h('div', { class: 'sk-muted', text: 'Updating…' }));

    for (const field of ['location', 'time']) {
        if (!on(field)) continue;
        rows.push(h('label', { class: 'sk-field' }, [
            LABELS[field],
            h('input', { class: 'text_pole', type: 'text', value: draft[field], oninput: edit((v) => { draft[field] = v; }) }),
        ]));
    }

    if (on('present')) {
        const list = h('div', { class: 'sk-present' });
        const renderPeople = () => list.replaceChildren(...draft.present.map((person, i) => h('div', { class: 'sk-person' }, [
            h('input', { class: 'text_pole', type: 'text', placeholder: 'name', value: person.name, oninput: edit((v) => { person.name = v; }) }),
            ...PERSON_ATTRS.map((attr) => h('input', {
                class: 'text_pole', type: 'text', placeholder: attr, value: person[attr], oninput: edit((v) => { person[attr] = v; }),
            })),
            h('button', { class: 'menu_button', type: 'button', title: 'Remove', onclick: () => { draft.present.splice(i, 1); onDirty(); renderPeople(); } }, '✕'),
        ])));
        renderPeople();
        rows.push(h('div', { class: 'sk-field' }, [
            'Present',
            list,
            h('button', {
                class: 'menu_button', type: 'button',
                onclick: () => { draft.present.push({ name: '', outfit: '', condition: '', mood: '' }); onDirty(); renderPeople(); },
            }, 'Add person'),
        ]));
    }

    if (on('threads')) {
        rows.push(h('label', { class: 'sk-field' }, [
            'Open threads (one per line)',
            h('textarea', { class: 'text_pole', rows: 4, value: draft.threads.join('\n'), oninput: edit((v) => { draft.threads = v.split('\n'); }) }),
        ]));
    }

    const sources = Object.entries(view.provenance);
    if (sources.length) {
        rows.push(h('details', { class: 'sk-prov' }, [
            h('summary', { text: 'Where these came from' }),
            ...sources.map(([path, entry]) => h('div', { class: 'sk-prov-row' }, [
                `${path}: `,
                entry.manual || entry.mesId == null
                    ? provenanceText(entry)
                    : h('button', { class: 'sk-link', type: 'button', onclick: () => onJump(entry.mesId) }, provenanceText(entry)),
            ])),
        ]));
    }

    rows.push(h('div', { class: 'sk-actions' }, [
        h('button', { class: 'menu_button', type: 'button', onclick: () => onSave(draft) }, 'Save scene'),
        h('button', { class: 'menu_button', type: 'button', onclick: onRevert }, 'Revert'),
    ]));
    container.replaceChildren(...rows);
}
```

`src/ui/inspector.js`:
```js
import { h } from './dom.js';
import { reportLine, statsLines } from './format.js';

const section = (title, lines, extra = null) => h('div', { class: 'sk-section' }, [
    h('b', { text: title }),
    ...lines.map((line) => h('div', { class: 'sk-line', text: line })),
    extra,
]);

export function renderInspector(container, session, summary) {
    const plan = session.lastPlan;
    const planSection = plan
        ? section('Last plan', [`${plan.type}, ${plan.ms} ms, brief ~${plan.briefTokens} tokens`, ...plan.reports.map(reportLine)],
            plan.brief ? h('pre', { class: 'sk-brief', text: plan.brief }) : null)
        : section('Last plan', ['No generation yet.']);

    const observed = session.lastObserve;
    const observeSection = observed
        ? section('Last observe', [
            `message #${observed.mesId}`,
            ...observed.reports.map(reportLine),
            ...(observed.scene?.rejected ?? []).map((r) => `rejected ${r.path}: ${r.reason}`),
            ...(observed.scene?.warnings ?? []),
        ])
        : section('Last observe', ['Nothing observed yet.']);

    container.replaceChildren(planSection, observeSection, section('This session', statsLines(summary)));
}
```

`src/ui/panel.js` (replaces the stub):
```js
import { h } from './dom.js';
import { briefDoubleWarning, cacheHint } from './format.js';
import { describeStage } from '../runner.js';
import { summarizeStats } from '../stats.js';
import { getSettings, getContextView, presetPromptTexts, currentSource, currentModel } from '../st.js';
import { mountSettings, bindSettings, fillProfiles } from './settingsForm.js';
import { renderScenePanel } from './scenePanel.js';
import { renderInspector } from './inspector.js';

let root = null;
let deps = null;
let sceneDirty = false;
let draftKey = null; // chat, message and message text the open draft belongs to

const viewKey = (view) => `${view.chatId}:${view.index}:${view.textHash}`;

export async function initPanel(options) {
    deps = options;
    root = await mountSettings();
    fillProfiles(root);
    bindSettings(root, refreshPanel);
    root.querySelector('[data-sk-setting="stages.scene.profileId"]').addEventListener('focus', () => fillProfiles(root));
    root.querySelector('#sangkhem-lore-test').addEventListener('click', async () => {
        const reachable = await deps.laya.health(getSettings().stages.lore.serviceUrl);
        if (reachable) toastr.success('Laya service is reachable.', 'sangkhem');
        else toastr.error('Could not reach the Laya service. Is it running?', 'sangkhem');
        refreshPanel();
    });
    refreshPanel();
}

function renderScene(view = deps.conductor.currentView()) {
    draftKey = viewKey(view);
    renderScenePanel(root.querySelector('#sangkhem-scene-panel'), {
        view,
        fields: getSettings().stages.scene.fields,
        onDirty: () => { sceneDirty = true; },
        onSave: async (draft) => {
            const result = await deps.conductor.setState(draft, { chatId: view.chatId, index: view.index, textHash: view.textHash });
            if (!result.ok) {
                toastr.warning(result.error, 'sangkhem', { escapeHtml: true });
                return;
            }
            sceneDirty = false;
            renderScene();
        },
        onRevert: () => { sceneDirty = false; renderScene(); },
        onRetry: () => deps.conductor.retry(),
        onJump: (mesId) => document.querySelector(`#chat .mes[mesid="${Number(mesId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    });
}

export function refreshPanel() {
    if (!root) return;
    try {
        const settings = getSettings();
        const ctx = getContextView();
        const statuses = deps.stages.map((stage) => describeStage(stage, settings, ctx));
        root.querySelector('#sangkhem-stage-status').replaceChildren(...statuses.map((s) => h('div', {
            class: `sk-status sk-${s.status}`, text: `${s.id}: ${s.status}${s.reason ? ` — ${s.reason}` : ''}`,
        })));
        const warnings = [
            briefDoubleWarning(settings.stages.brief.mode, presetPromptTexts()),
            cacheHint({ source: currentSource(), model: currentModel(), protectCachePrefix: settings.stages.lore.protectCachePrefix }),
        ].filter(Boolean);
        root.querySelector('#sangkhem-warnings').replaceChildren(...warnings.map((text) => h('div', { class: 'sk-warning', text })));
        renderInspector(root.querySelector('#sangkhem-inspector'), deps.conductor.session, summarizeStats(deps.conductor.session.stats));
        const view = deps.conductor.currentView();
        // A draft for another chat or an older message is dropped rather than saved onto this one.
        if (sceneDirty && draftKey !== viewKey(view)) sceneDirty = false;
        if (!sceneDirty) renderScene(view);
    } catch (error) {
        console.error('[sangkhem] panel refresh failed', error);
    }
}
```

`style.css`:
```css
.sangkhem-settings h4 { margin: 0.8em 0 0.3em; }
.sangkhem-settings h5 { margin: 0.8em 0 0.2em; opacity: 0.8; }
.sangkhem-settings label { display: block; margin: 0.25em 0; }
.sk-muted { opacity: 0.7; font-style: italic; }
.sk-warning, .sk-stale { border-left: 3px solid var(--warning, #d9a400); padding: 0.3em 0.5em; margin: 0.3em 0; }
.sk-status.sk-ready::before { content: '● '; color: #3a9d5d; }
.sk-status.sk-unavailable::before { content: '● '; color: #d9a400; }
.sk-status.sk-off::before { content: '○ '; opacity: 0.6; }
.sk-person { display: grid; grid-template-columns: repeat(4, 1fr) auto; gap: 0.25em; margin: 0.2em 0; }
.sk-field { margin: 0.4em 0; }
.sk-section { margin: 0.4em 0; }
.sk-line, .sk-prov-row { font-size: 0.9em; }
.sk-brief { white-space: pre-wrap; font-size: 0.85em; opacity: 0.85; }
.sk-link { background: none; border: none; color: var(--SmartThemeQuoteColor, inherit); cursor: pointer; padding: 0; text-align: left; }
.sk-actions { display: flex; gap: 0.5em; margin-top: 0.5em; }
@media (max-width: 600px) { .sk-person { grid-template-columns: 1fr 1fr; } }
```

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS (the imports test confirms the UI modules follow the globals rule).

- [ ] **Step 8: Check the panel in SillyTavern**

Reload ST. Open Extensions → sangkhem. Expected:
- Stage list shows `memory`, `lore`, `brief`, `scene` with ready/unavailable/off and reasons (scene: "choose a connection profile for scene tracking" until one is picked).
- Changing a setting persists across reload.
- Picking a connection profile turns scene to `ready`.
- After a reply, the inspector shows the last plan and observe; the scene panel shows fields; editing and saving writes the state (check with `/scene`).
- Put `<b>x</b>` in the location field, save, reload: it shows literally, not bold.

- [ ] **Step 9: Commit**

```bash
git add settings.html style.css src/ui tests/dom.test.js tests/format.test.js
git commit -m "feat: add settings, scene panel and turn inspector"
```

---

### Task 15: Laya service copy

**Files:**
- Create: `service/laya/server.py`, `service/laya/requirements.txt` (copied unchanged), `service/laya/README.md`

**Interfaces:**
- Produces: the same HTTP API the Lore stage calls: `GET /health → {"status":"ok"}`, `POST /wi-director {message, recent_turns, candidates:[{id, content}]} → {"results":[{id, relevance, usefulness}]}`. Host/port via `LAYA_WID_HOST` / `LAYA_WID_PORT` (default `127.0.0.1:8666`).

- [ ] **Step 1: Copy the service**

```bash
mkdir -p service/laya
cp /Users/westin/SillyTavern-Launcher/SillyTavern/public/scripts/extensions/third-party/laya-wi-director/service/server.py service/laya/
cp /Users/westin/SillyTavern-Launcher/SillyTavern/public/scripts/extensions/third-party/laya-wi-director/service/requirements.txt service/laya/
```

- [ ] **Step 2: Verify it is unchanged and compiles**

Run:
```bash
diff -q service/laya/server.py /Users/westin/SillyTavern-Launcher/SillyTavern/public/scripts/extensions/third-party/laya-wi-director/service/server.py && python3 -m py_compile service/laya/server.py && echo OK
```
Expected: `OK`. Then delete the `__pycache__` that `py_compile` creates: `rm -rf service/laya/__pycache__`.

- [ ] **Step 3: Write `service/laya/README.md`**

```markdown
# Laya service

Local HTTP service that scores World Info entries for the Lore stage. Same code and endpoints as
Laya WI Director's service, so either copy can run on the default URL `http://localhost:8666`.

## Run (Apple Silicon / macOS)

    cd service/laya
    python3 -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt   # pulls laya + torch; the first model download is ~2 GB
    python3 server.py

It prints `Laya ready (backend=torch).` and `Serving on http://127.0.0.1:8666`.

- `LAYA_WID_HOST` / `LAYA_WID_PORT` change the address.
- `LAYA_WID_BACKEND=mlx` uses the faster MLX backend (`pip install laya-mlx` first; untested here).

Then in SillyTavern: Extensions → sangkhem → Settings → Lore → **Test connection**.

## Endpoints

- `GET /health` → `{"status": "ok"}`
- `POST /wi-director` → `{"results": [{"id", "relevance", "usefulness"}]}` (scores 0–5)
- `POST /reply-guard`, `POST /echo-check` are used by Laya WI Director's reply guard, not by sangkhem v1.
```

- [ ] **Step 4: Commit**

```bash
git add service/laya/server.py service/laya/requirements.txt service/laya/README.md
git commit -m "chore: ship the Laya scoring service"
```

---

### Task 16: Scene extraction eval tool

**Files:**
- Create: `tools/eval-score.mjs`, `tools/eval-scene.mjs`, `tools/fixtures/scene/*.json` (8 files)
- Test: `tests/eval-score.test.js`

**Interfaces:**
- Consumes: `createSceneStage` (Task 7), `validateState`, `PERSON_ATTRS` (Task 3), `normalize` (Task 4), `mergeDefaults` (Task 1).
- Produces:
  - `fieldMatches(expected, actual) → boolean` (both empty; equal; one contains the other; or word Jaccard ≥ 0.5).
  - `scoreFixture(expected, actual, prev) → [{ field, changed, ok }]` — checks only the fields present in `expected`; `changed` means the fixture expects that field to differ from `prev`. An answer identical to `prev` fails an expected change even if it loosely matches.
  - `summarize(results: [{ checks }]) → { recall, stability, changes, byField: { [field]: { ok, total } } }` — recall over changed checks, stability over the rest.
  - CLI: `EVAL_API_KEY=… node tools/eval-scene.mjs --url <OpenAI-compatible base URL> --model <id> [--fixtures dir] [--max-tokens n]`. Uses the extension's scene settings (same temperature). A call that errors fails every check. Exit code 0 when recall ≥ 0.9 and stability ≥ 0.9.
  - Fixture format: `{ name, userName, charName, prev, user, reply, expected }`.

- [ ] **Step 1: Write the failing test**

`tests/eval-score.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fieldMatches, scoreFixture, summarize } from '../tools/eval-score.mjs';
import { validateState } from '../src/state.js';

const S = (raw) => validateState(raw, { threadsCap: 99 }).state;

test('fieldMatches is loose about wording', () => {
    assert.equal(fieldMatches('', ''), true);
    assert.equal(fieldMatches('rooftop', ''), false);
    assert.equal(fieldMatches('rooftop', 'the rooftop'), true);
    assert.equal(fieldMatches('forearm cut', 'bleeding cut on forearm'), true);
    assert.equal(fieldMatches('kitchen', 'rooftop'), false);
});

test('scoreFixture marks changed fields and checks only expected ones', () => {
    const prev = S({ location: 'kitchen', present: [{ name: 'Ellen', outfit: 'hoodie' }, { name: 'Mara' }], threads: [] });
    const actual = S({ location: 'rooftop', present: [{ name: 'Ellen', outfit: 'red coat' }, { name: 'Mara' }], threads: ['meet at the pier at dawn'] });
    const checks = scoreFixture({
        location: 'roof', present: [{ name: 'Ellen', outfit: 'coat' }, { name: 'Mara' }], threads: ['meet at dawn at the old pier'],
    }, actual, prev);
    assert.deepEqual(checks, [
        { field: 'location', changed: true, ok: true },
        { field: 'present.names', changed: false, ok: true },
        { field: 'present.outfit', changed: true, ok: true },
        { field: 'threads', changed: true, ok: true },
        { field: 'threads.closed', changed: false, ok: true },
    ]);
});

test('an unchanged answer fails an expected change even if it loosely matches', () => {
    const prev = S({ present: [{ name: 'Mara', outfit: 'jacket over a t-shirt' }] });
    const [, outfit] = scoreFixture({ present: [{ name: 'Mara', outfit: 't-shirt' }] }, prev, prev);
    assert.deepEqual(outfit, { field: 'present.outfit', changed: true, ok: false });
});

test('summarize reports recall and stability separately', () => {
    const summary = summarize([
        { checks: [{ field: 'location', changed: true, ok: true }, { field: 'time', changed: false, ok: true }] },
        { checks: [{ field: 'location', changed: true, ok: false }] },
    ]);
    assert.deepEqual([summary.recall, summary.stability, summary.changes], [0.5, 1, 2]);
    assert.deepEqual(summary.byField.location, { ok: 1, total: 2 });
    assert.equal(summarize([]).recall, null);
});

test('a model that changes nothing scores zero recall on the fixtures', () => {
    const dir = new URL('../tools/fixtures/scene/', import.meta.url);
    const results = readdirSync(dir).filter((f) => f.endsWith('.json')).map((file) => {
        const fixture = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
        const prev = validateState(fixture.prev).state;
        return { checks: scoreFixture(fixture.expected, prev, prev) };
    });
    const summary = summarize(results);
    assert.equal(summary.recall, 0);
    assert.ok(summary.changes >= 7);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/eval-score.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `tools/eval-score.mjs`**

```js
import { normalize } from '../src/evidence.js';
import { PERSON_ATTRS } from '../src/state.js';

const words = (text) => new Set(normalize(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(' ').filter(Boolean));
const same = (a, b) => normalize(a) === normalize(b);

/** Loose match: models word things differently, so containment or half the words in common counts. */
export function fieldMatches(expected, actual) {
    const e = normalize(expected);
    const a = normalize(actual);
    if (!e && !a) return true;
    if (!e || !a) return false;
    if (e === a || a.includes(e) || e.includes(a)) return true;
    const ew = words(e);
    const aw = words(a);
    const shared = [...ew].filter((w) => aw.has(w)).length;
    const union = new Set([...ew, ...aw]).size;
    return union > 0 && shared / union >= 0.5;
}

// A field the fixture expects to change only passes if the model changed it: an answer identical to
// the previous value fails even when the loose match would accept it.
function check(field, expected, actual, previous) {
    const changed = !same(expected, previous);
    const ok = fieldMatches(expected, actual) && !(changed && same(actual, previous));
    return { field, changed, ok };
}

/**
 * Checks only the fields present in `expected`. Each check says whether the fixture expects that
 * field to change from `prev` (recall) or stay the same (stability).
 */
export function scoreFixture(expected, actual, prev) {
    const checks = [];
    for (const field of ['location', 'time']) {
        if (field in expected) checks.push(check(field, expected[field], actual[field], prev[field]));
    }
    if (expected.present) {
        const key = (people) => people.map((p) => normalize(p.name)).sort().join('|');
        const actualByName = new Map(actual.present.map((p) => [normalize(p.name), p]));
        const prevByName = new Map(prev.present.map((p) => [normalize(p.name), p]));
        checks.push({
            field: 'present.names',
            changed: key(expected.present) !== key(prev.present),
            ok: key(expected.present) === key(actual.present),
        });
        for (const person of expected.present) {
            for (const attr of PERSON_ATTRS) {
                if (!(attr in person)) continue;
                const name = normalize(person.name);
                checks.push(check(`present.${attr}`, person[attr], actualByName.get(name)?.[attr] ?? '', prevByName.get(name)?.[attr] ?? ''));
            }
        }
    }
    if (expected.threads) {
        for (const thread of expected.threads) {
            checks.push({
                field: 'threads',
                changed: !prev.threads.some((t) => fieldMatches(thread, t)),
                ok: actual.threads.some((t) => fieldMatches(thread, t)),
            });
        }
        checks.push({
            field: 'threads.closed',
            changed: prev.threads.length > expected.threads.length,
            ok: actual.threads.length <= expected.threads.length,
        });
    }
    return checks;
}

const ratio = (checks) => (checks.length ? checks.filter((c) => c.ok).length / checks.length : null);

/** recall: expected changes found; stability: unchanged fields left alone. */
export function summarize(results) {
    const all = results.flatMap((r) => r.checks);
    const byField = {};
    for (const c of all) {
        byField[c.field] ??= { ok: 0, total: 0 };
        byField[c.field].total++;
        if (c.ok) byField[c.field].ok++;
    }
    return {
        recall: ratio(all.filter((c) => c.changed)),
        stability: ratio(all.filter((c) => !c.changed)),
        changes: all.filter((c) => c.changed).length,
        byField,
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/eval-score.test.js`
Expected: PASS, 0 failures.

- [ ] **Step 5: Write `tools/eval-scene.mjs`**

```js
#!/usr/bin/env node
// Measures scene extraction for one model against tools/fixtures/scene. Uses the extension's own
// scene settings (including its pinned temperature) so it measures what the extension sends.
// Reports change recall (did the model catch what changed) and stability (did it leave the rest
// alone). A call that errors counts as failing every check.
// Usage: EVAL_API_KEY=... node tools/eval-scene.mjs --url https://openrouter.ai/api/v1 --model google/gemini-2.5-flash
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSceneStage } from '../src/stages/scene.js';
import { validateState } from '../src/state.js';
import { mergeDefaults } from '../src/settings.js';
import { scoreFixture, summarize } from './eval-score.mjs';

const { values } = parseArgs({
    options: {
        url: { type: 'string' },
        model: { type: 'string' },
        fixtures: { type: 'string', default: fileURLToPath(new URL('./fixtures/scene/', import.meta.url)) },
        'max-tokens': { type: 'string', default: '800' },
    },
});
if (!values.url || !values.model) {
    console.error('Usage: EVAL_API_KEY=... node tools/eval-scene.mjs --url <OpenAI-compatible base URL> --model <model id>');
    process.exit(2);
}

const llm = {
    async complete(_profileId, messages, { maxTokens, temperature, signal }) {
        const response = await fetch(`${values.url.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.EVAL_API_KEY ? { Authorization: `Bearer ${process.env.EVAL_API_KEY}` } : {}),
            },
            body: JSON.stringify({ model: values.model, messages, max_tokens: maxTokens, temperature }),
            signal,
        });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        const data = await response.json();
        return data.choices?.[0]?.message?.content ?? '';
    },
};

const config = { ...mergeDefaults({}).stages.scene, profileId: 'eval', maxTokens: Number(values['max-tokens']) };
const stage = createSceneStage({ llm });
const files = (await readdir(values.fixtures)).filter((f) => f.endsWith('.json')).sort();
const results = [];
let rejections = 0;

for (const file of files) {
    const fixture = JSON.parse(await readFile(join(values.fixtures, file), 'utf8'));
    const prev = validateState(fixture.prev ?? {}).state;
    let state = prev;
    let rejected = [];
    let error = null;
    try {
        const result = await stage.run({
            mesId: 0, userText: fixture.user, replyText: fixture.reply,
            userName: fixture.userName, charName: fixture.charName, prevProvenance: {},
            signal: AbortSignal.timeout(60000),
        }, prev, config);
        state = result.statePatch ?? prev;
        rejected = result.output?.rejected ?? [];
    } catch (e) {
        error = e.message;
    }
    const scored = scoreFixture(fixture.expected, state, prev);
    const checks = error ? scored.map((c) => ({ ...c, ok: false })) : scored;
    rejections += rejected.length;
    results.push({ name: fixture.name, checks });
    const passed = checks.filter((c) => c.ok).length;
    console.log(`${passed === checks.length ? 'PASS' : 'FAIL'} ${fixture.name} (${passed}/${checks.length})${error ? ` error: ${error}` : ''}`);
    for (const check of checks) if (!check.ok) console.log(`    wrong: ${check.field}${check.changed ? ' (missed change)' : ' (changed something that should stay)'}`);
    for (const r of rejected) console.log(`    gate rejected ${r.path}: ${r.reason}`);
}

const summary = summarize(results);
const pct = (value) => `${((value ?? 0) * 100).toFixed(1)}%`;
console.log(`\nChange recall: ${pct(summary.recall)} of ${summary.changes} expected changes. Stability: ${pct(summary.stability)}. ${rejections} gate rejection(s).`);
for (const [field, s] of Object.entries(summary.byField)) console.log(`  ${field}: ${s.ok}/${s.total}`);
process.exitCode = (summary.recall ?? 0) >= 0.9 && (summary.stability ?? 0) >= 0.9 ? 0 : 1;
```

- [ ] **Step 6: Write the fixtures**

`tools/fixtures/scene/01-location-change.json`:
```json
{
    "name": "moves to the rooftop",
    "userName": "Mara", "charName": "Ellen",
    "prev": { "location": "Ellen's apartment, kitchen", "time": "evening", "present": [{ "name": "Ellen", "outfit": "oversized hoodie" }, { "name": "Mara" }], "threads": [] },
    "user": "Let's get some air. *I head for the stairs up to the roof.*",
    "reply": "Ellen trails after you up the stairs and shoulders open the rooftop door. Cold wind whips her hair across her face.",
    "expected": { "location": "rooftop", "present": [{ "name": "Ellen", "outfit": "oversized hoodie" }, { "name": "Mara" }] }
}
```

`tools/fixtures/scene/02-outfit-from-user.json`:
```json
{
    "name": "user gives away a jacket",
    "userName": "Mara", "charName": "Ellen",
    "prev": { "location": "rooftop", "time": "night", "present": [{ "name": "Ellen", "outfit": "oversized hoodie" }, { "name": "Mara", "outfit": "jacket over a t-shirt" }], "threads": [] },
    "user": "*I shrug off my jacket and drape it over Ellen's shoulders.*",
    "reply": "Ellen blinks at the jacket, then tugs it tighter around herself. \"Don't get used to this.\"",
    "expected": { "location": "rooftop", "present": [{ "name": "Ellen", "outfit": "jacket over hoodie" }, { "name": "Mara", "outfit": "t-shirt" }] }
}
```

`tools/fixtures/scene/03-character-leaves.json`:
```json
{
    "name": "a character leaves",
    "userName": "Mara", "charName": "Ellen",
    "prev": { "location": "Victoria Housekeeping lobby", "time": "afternoon", "present": [{ "name": "Ellen" }, { "name": "Lycaon" }, { "name": "Mara" }], "threads": [] },
    "user": "Could someone bring the car around?",
    "reply": "Lycaon bows. \"I will see to it.\" He leaves, the door clicking shut behind him. Ellen yawns.",
    "expected": { "present": [{ "name": "Ellen" }, { "name": "Mara" }] }
}
```

`tools/fixtures/scene/04-new-thread.json`:
```json
{
    "name": "a meeting is set up",
    "userName": "Mara", "charName": "Ellen",
    "prev": { "location": "cafe", "time": "evening", "present": [{ "name": "Ellen" }, { "name": "Mara" }], "threads": ["Ellen owes Mara a favor"] },
    "user": "So what do you need from me?",
    "reply": "Ellen slides a folded note across the table. \"Tomorrow at dawn. The old pier. Come alone.\"",
    "expected": { "threads": ["Ellen owes Mara a favor", "meet Ellen at the old pier at dawn"] }
}
```

`tools/fixtures/scene/05-thread-resolved.json`:
```json
{
    "name": "a thread is resolved",
    "userName": "Mara", "charName": "Ellen",
    "prev": { "location": "Ellen's apartment, living room", "time": "night", "present": [{ "name": "Ellen" }, { "name": "Mara" }], "threads": ["shark plushie still missing", "Ellen owes Mara a favor"] },
    "user": "Did you check under the couch?",
    "reply": "Ellen digs under the cushions and pulls out the shark plushie, looking smug. \"Found him.\"",
    "expected": { "threads": ["Ellen owes Mara a favor"] }
}
```

`tools/fixtures/scene/06-no-change.json`:
```json
{
    "name": "nothing changes",
    "userName": "Mara", "charName": "Ellen",
    "prev": { "location": "Ellen's apartment, living room", "time": "night, raining", "present": [{ "name": "Ellen", "outfit": "oversized hoodie", "mood": "bored" }, { "name": "Mara" }], "threads": ["Ellen owes Mara a favor"] },
    "user": "What are you thinking about?",
    "reply": "Ellen shrugs, watching the rain streak the window. \"Nothing. Sharks, maybe.\"",
    "expected": { "location": "Ellen's apartment, living room", "time": "night, raining", "present": [{ "name": "Ellen", "outfit": "oversized hoodie" }, { "name": "Mara" }], "threads": ["Ellen owes Mara a favor"] }
}
```

`tools/fixtures/scene/07-time-passes.json`:
```json
{
    "name": "time passes",
    "userName": "Mara", "charName": "Ellen",
    "prev": { "location": "Ellen's apartment, living room", "time": "early evening", "present": [{ "name": "Ellen" }, { "name": "Mara" }], "threads": [] },
    "user": "*I put on another movie.*",
    "reply": "Hours slip by. By the time the credits roll, it's past midnight and the sky outside has gone pitch black.",
    "expected": { "time": "past midnight" }
}
```

`tools/fixtures/scene/08-injury.json`:
```json
{
    "name": "an injury",
    "userName": "Mara", "charName": "Ellen",
    "prev": { "location": "Hollow, ruined subway platform", "time": "unknown", "present": [{ "name": "Ellen", "condition": "" }, { "name": "Mara" }], "threads": [] },
    "user": "*I shout a warning as the Ethereal lunges.*",
    "reply": "Too late. The creature's claw catches Ellen's forearm; she hisses as blood wells through her sleeve.",
    "expected": { "present": [{ "name": "Ellen", "condition": "forearm cut, bleeding" }, { "name": "Mara" }] }
}
```

- [ ] **Step 7: Run the eval against a real model**

Pick the model you plan to use for the Scene stage (for example the Gemma-4-E4B model in LM Studio, `http://localhost:1234/v1`, or a free OpenRouter model):
```bash
node tools/eval-scene.mjs --url http://localhost:1234/v1 --model rpdungeon_gemma-4-e4b-luchador
```
Expected: one PASS/FAIL line per fixture, then change recall and stability. Record both in the commit message. If recall or stability is below 90%, try another model before relying on scene tracking; this is success criterion 1. (A model that changes nothing scores 0% recall; `tests/eval-score.test.js` pins that.) The eight fixtures are a starting set — add more from real chats (edit names and details) as you play.

- [ ] **Step 8: Commit**

```bash
git add tools tests/eval-score.test.js
git commit -m "feat: add scene extraction eval tool and fixtures"
```

---

### Task 17: README, manual checklist and end-to-end check

**Files:**
- Create: `README.md`, `docs/manual-test.md`

**Interfaces:**
- Consumes: the finished extension.

- [ ] **Step 1: Write `README.md`**

```markdown
# sangkhem

A SillyTavern extension that runs small helper stages around your narrator model, instead of asking one model to remember and track everything on its own.

Each turn has two phases:

- **Plan**, before the narrator writes: **Memory** reads your Summaryception summary, **Lore** scores the World Info entries that matched and drops the low-value ones (using a local Laya model), and **Brief** adds short scene notes near the end of the prompt.
- **Observe**, after the reply is on screen: **Scene** asks a small model what changed (location, time, who is present and how they look, open plot threads). A change is only accepted if the model quotes the message that shows it.

Anything that fails or is missing is skipped. Replies always generate.

## Requirements

- SillyTavern 1.16 or newer.
- For scene tracking: a connection profile for a small or cheap model (Connection Manager).
- Optional: [Summaryception](https://github.com/Lodactio/Extension-Summaryception) for the Memory stage.
- Optional: the Laya service in `service/laya` for the Lore stage.

## Install

Extensions → Install extension → `https://github.com/soliloquy1/sangkhem`

## Set up

1. Extensions → sangkhem → Settings → Scene tracking: pick a connection profile.
2. Optional: start the Laya service (`service/laya/README.md`) and press **Test connection**.
3. If you use Laya WI Director, turn off its **Enable** (sangkhem's Lore stage replaces it; its reply guard can stay on).

The Stages list shows what is ready and what each stage needs.

## Using it

- The **Scene** section shows the current state. Edit and save to correct it; your edit wins until new evidence changes it. "Where these came from" links each fact to the message it was quoted from.
- The **Last turn** section shows what each stage did and how long it took, plus session timings.
- `/conductor on|off|status`, `/scene`, `/scene set location=rooftop`, `/scene set present.Ellen.outfit=red coat`.
- Put `{{conductor_brief}}` in your preset and set Brief placement to macro mode to place the notes yourself.

## With other extensions

| Extension | What sangkhem does |
|---|---|
| Summaryception | Reads its summary; never injects it again. |
| SnapCompact | Leaves it alone. Lore entries the Lore stage drops are disabled before ST's real scan, so SnapCompact never receives or images them. |
| Laya WI Director | Replaces its lore pruning (turn that off); its reply guard keeps working. |
| Recast | Leaves it alone; scene tracking reads the rewritten reply. |
| CoT Guard, reasoning | Scene tracking ignores CoT blocks and skips replies that get auto-swiped. |

## Development

    npm test
    node tools/eval-scene.mjs --url <OpenAI-compatible URL> --model <id>

Design: `docs/superpowers/specs/2026-09-25-conductor-design.md`.
```

- [ ] **Step 2: Write `docs/manual-test.md`**

```markdown
# Manual test checklist

Run in a real SillyTavern with sangkhem symlinked into `data/default-user/extensions/`. Keep the browser console open; any `[sangkhem]` error is a failure.

## Setups

- [ ] Vanilla: no Summaryception, no Laya service, no scene profile. Replies generate normally; Stages shows memory/lore/scene unavailable with reasons; brief shows "no scene state yet".
- [ ] Full: Summaryception on, Laya service running, scene profile chosen.

## Generation types (full setup)

- [ ] Normal: reply arrives; about 1.5 s later the Scene section updates; inspector shows memory/lore/brief ran.
- [ ] Swipe: new swipe gets its own state; swiping back restores the earlier swipe's state.
- [ ] Regenerate: brief for the new reply uses the state from before the replaced message.
- [ ] Continue: no new plan in the inspector; the continued message is re-observed.
- [ ] Impersonate: plan runs; nothing is observed.
- [ ] Edit the AI message: scene re-observes. Edit the user message before it: the reply re-observes.
- [ ] Delete the last AI message: Scene falls back to the previous message's state.
- [ ] Branch from a message: the branch shows the state at that message.
- [ ] Stop a generation mid-plan: no error, next send works.
- [ ] Switch chats while a reply is being observed: nothing is written into the other chat.
- [ ] Group chat (two characters reply in a row): the second reply's scene includes changes from the first.
- [ ] Commit mode (Settings → Observe → when I send my next message): after a group turn, both replies are observed in order before the next plan.
- [ ] Edit a scene field while "Updating…" is shown and save: your edit is still there after the extraction finishes.
- [ ] Start editing the scene, switch chats, switch back: the draft is gone and nothing was saved into the other chat.

## Other extensions

- [ ] Recast on: the scene reflects the rewritten text (check the inspector's evidence quotes).
- [ ] CoT Guard auto-swipes: rejected replies are not observed (no scene call for them in the inspector).
- [ ] Laya WI Director enabled: Lore shows the conflict reason and does not run; turning it off makes Lore ready.
- [ ] Summaryception quiet summarisation runs: no extra plan appears in the inspector for it.

## Failure paths

- [ ] Stop the Laya service mid-session: Lore shows "unreachable" and replies still generate.
- [ ] Point the Lore service URL at an address that never answers and press Test connection: it reports failure within about 3 s.
- [ ] Slow scene model with a small plan budget: the brief is still injected (inspector shows brief ran).
- [ ] Pick a scene profile whose API key is wrong: after 3 replies one warning toast appears; Scene shows "Out of date" with Retry.
- [ ] Put `<b>x</b>` in a scene field and save: it displays literally.

## Brief placement

- [ ] Prompt itemization shows `<scene_notes>` just before the latest user message.
- [ ] Macro mode + `{{conductor_brief}}` in the preset: notes appear where placed and only once.

## Success-criteria A/B (spec)

- [ ] Two cards, 50 turns each with sangkhem off and on. Count continuity errors (wrong location, outfit/condition, presence, forgotten thread). Record counts and the inspector's session p50/p95 and token numbers in `docs/ab-results.md`.
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 4: Run the manual checklist**

Work through `docs/manual-test.md` in SillyTavern (the browser pane can drive it). Fix anything that fails with a test first where the logic is testable in Node. Tick the boxes in the file.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/manual-test.md
git commit -m "docs: add README and manual test checklist"
```
