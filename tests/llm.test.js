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
