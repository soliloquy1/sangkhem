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
