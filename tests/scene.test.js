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
