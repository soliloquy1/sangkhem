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
