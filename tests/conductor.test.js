import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConductor, observeInput, catchUpIndices } from '../src/conductor.js';
import { createBriefStage } from '../src/stages/brief.js';
import { mergeDefaults } from '../src/settings.js';
import { makeRecord, validateState } from '../src/state.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const user = (mes) => ({ is_user: true, name: 'Mara', mes });
const ai = (mes) => ({ is_user: false, name: 'Ellen', mes, extra: {} });

// Scene stand-in: the reply text becomes the location. Records what it saw.
function fakeScene({ fail = false, delay = 0 } = {}) {
    const calls = [];
    return {
        calls,
        stage: {
            id: 'scene', phase: 'observe', available: () => true,
            async run(turn, state) {
                calls.push({ mesId: turn.mesId, prevLocation: state.location, userText: turn.userText });
                if (delay) await sleep(delay);
                if (fail) throw new Error('model down');
                return {
                    statePatch: { location: turn.replyText },
                    output: { provenance: { location: { mesId: turn.mesId, quote: turn.replyText } }, accepted: ['location'], rejected: [] },
                };
            },
        },
    };
}

function harness({ chat = [], overrides = {}, scene = fakeScene() } = {}) {
    const settings = mergeDefaults({ settleMs: 10, observeWaitMs: 300, planBudgetMs: 1000, ...overrides });
    const calls = { saved: 0, prompts: [], notes: [], updates: 0 };
    let chatId = 'chat-1';
    const briefStore = { value: '' };
    const suppression = new Set();
    const deps = {
        getSettings: () => settings,
        getChat: () => chat,
        getChatId: () => chatId,
        getContextView: () => ({ extensionSettings: {}, chatMetadata: {}, disabledExtensions: [] }),
        names: () => ({ userName: 'Mara', charName: 'Ellen' }),
        saveChat: async () => { calls.saved++; },
        setBriefPrompt: (text, depth) => calls.prompts.push([text, depth]),
        countTokens: async (text) => Math.ceil(text.length / 4),
        notify: (id, reason, count) => calls.notes.push([id, reason, count]),
        onUpdate: () => { calls.updates++; },
    };
    const stages = [createBriefStage({ briefStore, setPrompt: deps.setBriefPrompt }), scene.stage];
    const conductor = createConductor({ deps, stages, suppression, briefStore });
    return { conductor, chat, settings, calls, briefStore, suppression, scene, switchChat: (id) => { chatId = id; } };
}

function record(chat, index, settings, raw, extra = {}) {
    const { textHash } = observeInput(chat, index, settings);
    chat[index].extra = { conductor: makeRecord({ state: validateState(raw).state, source: 'scene', textHash, ...extra }) };
}

const lastPrompt = (calls) => calls.prompts.at(-1)?.[0] ?? '';

test('observeInput pairs a reply with its user message and strips CoT', () => {
    const settings = mergeDefaults({});
    const chat = [user('hi'), ai('<thinking>x</thinking>Hello there.')];
    const input = observeInput(chat, 1, settings);
    assert.equal(input.userText, 'hi');
    assert.equal(input.replyText, 'Hello there.');
    assert.match(input.textHash, /^[0-9a-f]{8}$/);
});

test('observeInput gives consecutive group replies an empty user message', () => {
    const chat = [user('hi'), ai('Ellen speaks.'), { ...ai('Lycaon speaks.'), name: 'Lycaon' }];
    assert.equal(observeInput(chat, 2, mergeDefaults({})).userText, '');
});

test('quiet generations do nothing', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    await h.conductor.plan([], 8000, 'quiet');
    assert.deepEqual(h.calls.prompts, []);
    assert.equal(h.scene.calls.length, 0);
});

test('when disabled, the brief is cleared and no stage runs', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], overrides: { enabled: false } });
    await h.conductor.plan([], 8000, 'normal');
    assert.deepEqual(h.calls.prompts, [['', 1]]);
    assert.equal(h.scene.calls.length, 0);
});

test('continue keeps the previous brief', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    await h.conductor.plan([], 8000, 'continue');
    assert.deepEqual(h.calls.prompts, []);
});

test('plan injects the brief from the latest fresh state', async () => {
    const h = harness({ chat: [ai('hi'), user('u'), ai('talk')] });
    record(h.chat, 2, h.settings, { location: 'kitchen' });
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 0);
    assert.match(lastPrompt(h.calls), /Location: kitchen/);
    assert.equal(h.calls.prompts.at(-1)[1], 1);
    assert.equal(h.briefStore.value, lastPrompt(h.calls));
    assert.deepEqual(h.conductor.session.lastPlan.reports.map((r) => [r.id, r.status]), [['brief', 'ran']]);
});

test('a swipe reads state from before the message being replaced', async () => {
    const h = harness({ chat: [ai('a'), user('u'), ai('b')] });
    record(h.chat, 0, h.settings, { location: 'A' });
    record(h.chat, 2, h.settings, { location: 'B' });
    await h.conductor.plan([], 8000, 'swipe');
    assert.match(lastPrompt(h.calls), /Location: A/);
});

test('plan observes an unobserved latest reply first (bootstrap / commit mode)', async () => {
    const h = harness({ chat: [user('u'), ai('rooftop')] });
    await h.conductor.plan([], 8000, 'normal');
    assert.deepEqual(h.scene.calls.map((c) => c.mesId), [1]);
    assert.equal(h.chat[1].extra.conductor.state.location, 'rooftop');
    assert.equal(h.chat[1].extra.conductor.source, 'scene');
    assert.equal(h.calls.saved, 1);
    assert.match(lastPrompt(h.calls), /Location: rooftop/);
});

test('a fresh record is not observed again; an edited reply is', async () => {
    const h = harness({ chat: [user('u'), ai('rooftop')] });
    await h.conductor.plan([], 8000, 'normal');
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 1);
    h.chat[1].mes = 'garden';
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 2);
    assert.match(lastPrompt(h.calls), /Location: garden/);
});

test('settled mode observes after the reply arrives; commit mode waits', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'normal');
    assert.equal(h.conductor.currentView().pending, true);
    await sleep(40);
    assert.equal(h.chat[1].extra.conductor.state.location, 'roof');

    const c = harness({ chat: [user('u'), ai('roof')], overrides: { observeTrigger: 'commit' } });
    c.conductor.onMessageReceived(1, 'normal');
    assert.equal(c.conductor.currentView().pending, false);
});

test('quiet and impersonate replies are not observed', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'quiet');
    h.conductor.onMessageReceived(1, 'impersonate');
    assert.equal(h.conductor.currentView().pending, false);
});

test('plan flushes a pending observe before reading state', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], overrides: { settleMs: 10000 } });
    h.conductor.onMessageReceived(1, 'normal');
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 1);
    assert.match(lastPrompt(h.calls), /Location: roof/);
});

test('editing a user message re-observes the reply after it', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageEdited(0);
    await sleep(40);
    assert.deepEqual(h.scene.calls.map((c) => c.mesId), [1]);
});

test('a failed observe copies the previous state forward as stale and warns after the threshold', async () => {
    const scene = fakeScene({ fail: true });
    const h = harness({ chat: [ai('a'), user('u'), ai('b')], scene });
    record(h.chat, 0, h.settings, { location: 'kitchen' });
    await h.conductor.retry();
    const rec = h.chat[2].extra.conductor;
    assert.equal(rec.stale, true);
    assert.equal(rec.state.location, 'kitchen');
    assert.equal(h.conductor.currentView().stale, true);
    await h.conductor.retry();
    assert.equal(h.calls.notes.length, 0);
    await h.conductor.retry();
    assert.deepEqual(h.calls.notes, [['scene', 'model down', 3]]);
});

test('a result is discarded when the chat changes mid-observe', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const running = h.conductor.observe(1, new AbortController().signal);
    h.switchChat('chat-2');
    await running;
    assert.equal(h.chat[1].extra.conductor, undefined);
});

test('a result is discarded when the message is deleted or swiped mid-observe', async () => {
    const deleted = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const original = deleted.chat[1];
    const a = deleted.conductor.observe(1, new AbortController().signal);
    deleted.chat[1] = ai('other');
    await a;
    assert.equal(original.extra.conductor, undefined);
    assert.equal(deleted.chat[1].extra.conductor, undefined);

    const swiped = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const b = swiped.conductor.observe(1, new AbortController().signal);
    swiped.chat[1].mes = 'a different swipe';
    await b;
    assert.equal(swiped.chat[1].extra.conductor, undefined);
});

test('a manual record on the message is the base for re-observing it', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.chat[1].extra = { conductor: makeRecord({ state: validateState({ location: 'library' }).state, source: 'manual' }) };
    await h.conductor.retry();
    assert.equal(h.scene.calls[0].prevLocation, 'library');
});

test('editField writes a manual record with manual provenance', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    record(h.chat, 1, h.settings, { location: 'roof' });
    const result = await h.conductor.editField('present.Ellen.outfit', 'red coat');
    assert.equal(result.ok, true);
    const rec = h.chat[1].extra.conductor;
    assert.equal(rec.source, 'manual');
    assert.equal(rec.state.present[0].outfit, 'red coat');
    assert.deepEqual(rec.provenance['present.Ellen.outfit'], { mesId: null, quote: null, manual: true });
    assert.equal(h.calls.saved, 1);
    assert.equal((await h.conductor.editField('weather', 'rain')).ok, false);
});

test('editField needs a character message', async () => {
    const h = harness({ chat: [user('u')] });
    assert.deepEqual(await h.conductor.editField('location', 'x'), { ok: false, error: 'no character message to attach the scene to yet' });
});

test('suppression is cleared at plan start and applied on WORLDINFO_ENTRIES_LOADED', async () => {
    const h = harness({ chat: [user('u')] });
    h.suppression.add('w.1');
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.suppression.size, 0);
    h.suppression.add('w.2');
    const data = { globalLore: [{ world: 'w', uid: 2 }] };
    assert.equal(h.conductor.onWorldInfoLoaded(data), 1);
    assert.equal(data.globalLore[0].disable, true);
    h.conductor.onGenerationEnded();
    assert.equal(h.suppression.size, 0);
});

test('a chat change cancels pending observes and clears the brief', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'normal');
    h.conductor.onChatChanged();
    await sleep(40);
    assert.equal(h.scene.calls.length, 0);
    assert.deepEqual(h.calls.prompts.at(-1), ['', 1]);
});

test('swiping cancels the pending observe for that message', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'normal');
    h.conductor.onMessageSwiped(1);
    await sleep(40);
    assert.equal(h.scene.calls.length, 0);
});

test('the brief still runs when the observe wait uses the whole plan budget', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], overrides: { planBudgetMs: 20, observeWaitMs: 300 }, scene: fakeScene({ delay: 60 }) });
    await h.conductor.plan([], 8000, 'normal');
    const brief = h.conductor.session.lastPlan.reports.find((r) => r.id === 'brief');
    assert.equal(brief.status, 'ran');
    assert.match(lastPrompt(h.calls), /Location: roof/);
});

test('commit mode observes every reply of a group turn, in order', async () => {
    const lycaon = { ...ai('in the rain'), name: 'Lycaon' };
    const h = harness({ chat: [user('u'), ai('on the roof'), lycaon], overrides: { observeTrigger: 'commit' } });
    await h.conductor.plan([], 8000, 'normal');
    assert.deepEqual(h.scene.calls.map((c) => [c.mesId, c.prevLocation]), [[1, ''], [2, 'on the roof']]);
    assert.match(lastPrompt(h.calls), /Location: in the rain/);
});

test('catch-up stays within the current run and stops at a current record', () => {
    const settings = mergeDefaults({});
    const chat = [ai('old'), user('u'), ai('a'), ai('b'), ai('c')];
    assert.deepEqual(catchUpIndices(chat, chat.length, settings), [2, 3, 4]);
    record(chat, 3, settings, { location: 'x' });
    assert.deepEqual(catchUpIndices(chat, chat.length, settings), [4]);
    const long = [user('u'), ...Array.from({ length: 6 }, (_, i) => ai(`r${i}`))];
    assert.deepEqual(catchUpIndices(long, long.length, settings), [3, 4, 5, 6]);
});

test('a manual edit made while an extraction runs is not overwritten', async () => {
    const viaScheduler = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const running = viaScheduler.conductor.retry();
    await sleep(5);
    await viaScheduler.conductor.editField('location', 'library');
    await running;
    assert.deepEqual([viaScheduler.chat[1].extra.conductor.source, viaScheduler.chat[1].extra.conductor.state.location], ['manual', 'library']);

    const direct = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const observing = direct.conductor.observe(1, new AbortController().signal);
    await sleep(5);
    await direct.conductor.editField('location', 'library');
    await observing;
    assert.equal(direct.chat[1].extra.conductor.state.location, 'library');
});

test('setState refuses a draft from another chat or an older message', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    const view = h.conductor.currentView();
    assert.deepEqual([view.chatId, view.index], ['chat-1', 1]);
    assert.match(view.textHash, /^[0-9a-f]{8}$/);
    h.switchChat('chat-2');
    assert.match((await h.conductor.setState(view.state, { chatId: view.chatId, index: view.index })).error, /chat changed/);
    h.switchChat('chat-1');
    h.chat.push(user('again'), ai('garden'));
    assert.match((await h.conductor.setState(view.state, { chatId: view.chatId, index: view.index })).error, /newer message/);
    assert.equal((await h.conductor.setState(view.state, { chatId: 'chat-1', index: 3 })).ok, true);
});

test('a stale copy of a manual record is labelled scene, not manual', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ fail: true }) });
    h.chat[1].extra = { conductor: makeRecord({ state: validateState({ location: 'library' }).state, source: 'manual' }) };
    await h.conductor.retry();
    const rec = h.chat[1].extra.conductor;
    assert.deepEqual([rec.stale, rec.source, rec.state.location], [true, 'scene', 'library']);
});

test('continue cancels the pending observe for the last message', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    h.conductor.onMessageReceived(1, 'normal');
    h.conductor.onGenerationStarted('continue', {}, false);
    await sleep(40);
    assert.equal(h.scene.calls.length, 0);
});

test('a manual edit on a reply with no record survives the next plan', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], scene: fakeScene({ delay: 30 }) });
    const running = h.conductor.retry();
    await sleep(5);
    await h.conductor.editField('location', 'library');
    await running;
    await h.conductor.plan([], 8000, 'normal');
    assert.deepEqual([h.chat[1].extra.conductor.source, h.chat[1].extra.conductor.state.location], ['manual', 'library']);
    assert.match(lastPrompt(h.calls), /Location: library/);
});

test('in commit mode a manual edit is not re-extracted at the next plan', async () => {
    const h = harness({ chat: [user('u'), ai('roof')], overrides: { observeTrigger: 'commit' } });
    await h.conductor.editField('location', 'library');
    await h.conductor.plan([], 8000, 'normal');
    assert.equal(h.scene.calls.length, 0);
    assert.equal(h.chat[1].extra.conductor.state.location, 'library');
});

test('setState refuses a draft opened on a different swipe of the same message', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    const view = h.conductor.currentView();
    h.chat[1].mes = 'garden';
    const result = await h.conductor.setState(view.state, { chatId: view.chatId, index: view.index, textHash: view.textHash });
    assert.match(result.error, /message changed/);
    assert.equal(h.chat[1].extra.conductor, undefined);
});

test('statusText summarises state', async () => {
    const h = harness({ chat: [user('u'), ai('roof')] });
    assert.match(h.conductor.statusText(), /sangkhem is on\.\nScene: not tracked yet\./);
    await h.conductor.plan([], 8000, 'normal');
    assert.match(h.conductor.statusText(), /Last plan \(\d+ ms\): brief ran/);
    assert.match(h.conductor.statusText(), /Scene: up to date\./);
});
