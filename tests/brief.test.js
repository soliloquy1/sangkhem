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
