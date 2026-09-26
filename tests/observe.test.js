import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ObserveScheduler } from '../src/observe.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recorder({ delay = 0, fail = false } = {}) {
    const runs = [];
    const run = async (mesId, signal) => {
        const entry = { mesId, signal, done: false };
        runs.push(entry);
        if (delay) await sleep(delay);
        if (fail) throw new Error('boom');
        entry.done = true;
    };
    return { runs, run };
}

test('runs once after the settle delay, debouncing repeated schedules', async () => {
    const { runs, run } = recorder();
    const scheduler = new ObserveScheduler({ run });
    scheduler.schedule(3, 20);
    await sleep(10);
    scheduler.schedule(3, 20);
    assert.equal(scheduler.isPending(3), true);
    await sleep(40);
    assert.equal(runs.length, 1);
    assert.equal(scheduler.isPending(3), false);
});

test('rescheduling while running aborts the run and starts again', async () => {
    const { runs, run } = recorder({ delay: 30 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.start(1);
    await sleep(5);
    scheduler.schedule(1, 5);
    assert.equal(runs[0].signal.aborted, true);
    await sleep(100);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].signal.aborted, false);
    assert.equal(scheduler.isPending(1), false);
});

test('runs one at a time, in start order', async () => {
    const order = [];
    const scheduler = new ObserveScheduler({ run: async (mesId) => { order.push(`start ${mesId}`); await sleep(15); order.push(`end ${mesId}`); } });
    scheduler.start(1);
    scheduler.start(2);
    assert.equal(await scheduler.flush(2, 200), true);
    assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('a queued job cancelled before its turn never runs', async () => {
    const { runs, run } = recorder({ delay: 20 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.start(1);
    scheduler.start(2);
    scheduler.cancel(2);
    await sleep(50);
    assert.deepEqual(runs.map((r) => r.mesId), [1]);
});

test('cancel stops a waiting job and aborts a running one', async () => {
    const { runs, run } = recorder({ delay: 30 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.schedule(1, 10);
    scheduler.cancel(1);
    scheduler.start(2);
    await sleep(5);
    scheduler.cancel(2);
    assert.equal(runs[0].mesId, 2);
    assert.equal(runs[0].signal.aborted, true);
    await sleep(40);
    assert.equal(runs.length, 1);
    assert.equal(scheduler.isPending(1) || scheduler.isPending(2), false);
});

test('cancelAll clears everything', async () => {
    const { runs, run } = recorder();
    const scheduler = new ObserveScheduler({ run });
    scheduler.schedule(1, 10);
    scheduler.schedule(2, 10);
    scheduler.cancelAll();
    await sleep(30);
    assert.equal(runs.length, 0);
});

test('flush starts a waiting job now and waits for it', async () => {
    const { runs, run } = recorder({ delay: 10 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.schedule(4, 10000);
    assert.equal(await scheduler.flush(4, 200), true);
    assert.equal(runs[0].done, true);
    assert.equal(await scheduler.flush(99, 10), true);
});

test('flush gives up after waitMs but the run continues', async () => {
    const { runs, run } = recorder({ delay: 60 });
    const scheduler = new ObserveScheduler({ run });
    scheduler.start(4);
    assert.equal(await scheduler.flush(4, 10), false);
    await sleep(80);
    assert.equal(runs[0].done, true);
});

test('run errors go to onError unless the run was aborted', async () => {
    const errors = [];
    const { run } = recorder({ fail: true });
    const scheduler = new ObserveScheduler({ run, onError: (error, mesId) => errors.push([error.message, mesId]) });
    await scheduler.start(7);
    assert.deepEqual(errors, [['boom', 7]]);
});
