import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayaScorer, DOWN_RETRY_MS } from '../src/backends/scorers/laya.js';
import { BackendUnavailableError } from '../src/backends/resolve.js';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const at = (url) => () => url;

test('posts candidates and maps results', async () => {
    const requests = [];
    const scorer = createLayaScorer({ getServiceUrl: at('http://x:1'), fetchImpl: async (url, init) => { requests.push([url, JSON.parse(init.body)]); return ok({ results: [{ id: 'w.1', relevance: 4, usefulness: '3' }, { bad: true }] }); } });
    const result = await scorer.score([{ id: 'w.1', content: 'lore' }], { message: 'm', recent: ['r'] }, { serviceUrl: 'http://x:1/' });
    assert.deepEqual(result, [{ id: 'w.1', relevance: 4, usefulness: 3 }]);
    assert.equal(requests[0][0], 'http://x:1/wi-director');
    assert.deepEqual(requests[0][1], { message: 'm', recent_turns: ['r'], candidates: [{ id: 'w.1', content: 'lore' }] });
    assert.equal(scorer.available(), true);
});

test('a fresh scorer stays unavailable until the service answers a health probe', async () => {
    const urls = [];
    const scorer = createLayaScorer({ getServiceUrl: at('http://x'), fetchImpl: async (url) => { urls.push(url); return ok({ status: 'ok' }); } });
    assert.match(scorer.available(), /checking the Laya service at http:\/\/x/);
    await tick();
    assert.deepEqual(urls, ['http://x/health']);
    assert.equal(scorer.available(), true);
});

test('a fresh scorer with no service reports it unreachable after the probe', async () => {
    const scorer = createLayaScorer({ getServiceUrl: at('http://x'), fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.match(scorer.available(), /checking/);
    await tick();
    assert.match(scorer.available(), /Laya service unreachable at http:\/\/x/);
});

test('changing the service URL checks again', async () => {
    let url = 'http://a';
    const scorer = createLayaScorer({ getServiceUrl: () => url, fetchImpl: async () => ok({ status: 'ok' }) });
    scorer.available();
    await tick();
    assert.equal(scorer.available(), true);
    url = 'http://b';
    assert.match(scorer.available(), /checking the Laya service at http:\/\/b/);
});

test('a network error marks the service down until the retry time, then probes again', async () => {
    let clock = 1000;
    const scorer = createLayaScorer({ getServiceUrl: at('http://x'), fetchImpl: async () => { throw new TypeError('fetch failed'); }, now: () => clock });
    await assert.rejects(scorer.score([], { message: '', recent: [] }, { serviceUrl: 'http://x' }), BackendUnavailableError);
    assert.match(scorer.available(), /Laya service unreachable/);
    clock += DOWN_RETRY_MS;
    assert.match(scorer.available(), /checking the Laya service/);
});

test('an HTTP error is a plain failure and the service counts as reachable', async () => {
    const scorer = createLayaScorer({ getServiceUrl: at('http://x'), fetchImpl: async () => ({ ok: false, status: 500 }) });
    await assert.rejects(scorer.score([], { message: '', recent: [] }, { serviceUrl: 'http://x' }), /returned 500/);
    assert.equal(scorer.available(), true);
});

test('an aborted request does not mark the service down', async () => {
    const controller = new AbortController();
    controller.abort();
    const scorer = createLayaScorer({ getServiceUrl: at('http://x'), fetchImpl: async () => { throw new DOMException('aborted', 'AbortError'); } });
    await assert.rejects(scorer.score([], { message: '', recent: [] }, { serviceUrl: 'http://x', signal: controller.signal }), /aborted/);
    assert.doesNotMatch(String(scorer.available()), /unreachable/);
});

test('health gives up on a host that never answers', async () => {
    const scorer = createLayaScorer({ fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }) });
    const started = Date.now();
    assert.equal(await scorer.health('http://10.255.255.1'), false);
    assert.ok(Date.now() - started < 3500);
});

test('health checks /health and clears the down state', async () => {
    let up = false;
    const scorer = createLayaScorer({ getServiceUrl: at('http://x'), fetchImpl: async (url) => { if (!up) throw new TypeError('down'); assert.equal(url, 'http://x/health'); return ok({ status: 'ok' }); } });
    await assert.rejects(scorer.score([], { message: '', recent: [] }, { serviceUrl: 'http://x' }));
    assert.notEqual(scorer.available(), true);
    assert.equal(await scorer.health('http://x'), false);
    up = true;
    assert.equal(await scorer.health('http://x'), true);
    assert.equal(scorer.available(), true);
});
