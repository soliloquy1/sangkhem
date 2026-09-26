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
