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
