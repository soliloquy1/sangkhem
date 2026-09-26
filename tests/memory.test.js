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
