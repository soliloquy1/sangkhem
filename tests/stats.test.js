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
