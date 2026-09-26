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
