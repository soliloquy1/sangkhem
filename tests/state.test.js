import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    emptyState, validateState, isAiMessage, latestAiIndex, previousUserIndex, readState,
    makeRecord, writeRecord, hashText, isFresh, parseSceneSet, applyFieldEdit,
} from '../src/state.js';

const user = (mes) => ({ is_user: true, mes });
const ai = (mes, conductor) => ({ is_user: false, mes, extra: conductor ? { conductor } : {} });
const sys = (mes) => ({ is_user: false, is_system: true, mes });
const good = { location: 'kitchen', time: 'night', present: [{ name: 'Ellen', outfit: 'hoodie' }], threads: ['owes a favor'] };

test('validateState fills defaults and trims', () => {
    const result = validateState({ location: '  kitchen ', present: [{ name: 'Ellen' }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.state, {
        v: 1, location: 'kitchen', time: '', present: [{ name: 'Ellen', outfit: '', condition: '', mood: '' }], threads: [],
    });
});

test('validateState rejects wrong types', () => {
    assert.equal(validateState(null).ok, false);
    assert.equal(validateState([]).ok, false);
    assert.match(validateState({ location: 5 }).error, /location/);
    assert.match(validateState({ present: 'Ellen' }).error, /present/);
    assert.match(validateState({ present: [{ name: 'Ellen', mood: {} }] }).error, /mood/);
    assert.match(validateState({ threads: [1] }).error, /threads/);
});

test('validateState drops nameless and duplicate people with warnings', () => {
    const result = validateState({ present: [{ outfit: 'x' }, { name: 'Ellen' }, { name: 'ellen' }] });
    assert.deepEqual(result.state.present.map((p) => p.name), ['Ellen']);
    assert.equal(result.warnings.length, 2);
});

test('validateState dedupes threads and keeps the first threadsCap', () => {
    const result = validateState({ threads: ['a', 'A', 'b', 'c', ''] }, { threadsCap: 2 });
    assert.deepEqual(result.state.threads, ['a', 'b']);
    assert.match(result.warnings[0], /kept the first 2 of 3 threads/);
});

test('message helpers', () => {
    const chat = [ai('greeting'), user('hi'), sys('note'), ai('reply')];
    assert.equal(isAiMessage(chat[0]), true);
    assert.equal(isAiMessage(chat[2]), false);
    assert.equal(latestAiIndex(chat), 3);
    assert.equal(latestAiIndex(chat, 3), 0);
    assert.equal(latestAiIndex([]), -1);
    assert.equal(previousUserIndex(chat, 3), 1);
});

test('previousUserIndex stops at an earlier AI message (group chats)', () => {
    const chat = [user('hi'), ai('Ellen replies'), ai('Lycaon replies')];
    assert.equal(previousUserIndex(chat, 2), -1);
    assert.equal(previousUserIndex(chat, 1), 0);
});

test('readState finds the latest AI message with a valid record', () => {
    const chat = [
        ai('a', { state: { ...good, location: 'old' } }),
        user('u'),
        ai('b', { state: { location: 7 } }),
        ai('c'),
    ];
    const found = readState(chat);
    assert.equal(found.index, 0);
    assert.equal(found.state.location, 'old');
    assert.deepEqual(readState(chat, { before: 0 }), { state: emptyState(), record: null, index: -1 });
});

test('readState ignores records on user messages', () => {
    const chat = [{ is_user: true, mes: 'x', extra: { conductor: { state: good } } }];
    assert.equal(readState(chat).index, -1);
});

test('writeRecord writes the message and its active swipe', () => {
    const message = { mes: 'x', swipe_id: 1, swipe_info: [{ extra: {} }, { extra: { other: 1 } }] };
    const record = makeRecord({ state: emptyState(), source: 'scene', textHash: 'abc', now: () => 'T' });
    writeRecord(message, record);
    assert.deepEqual(message.extra.conductor, { state: emptyState(), provenance: {}, source: 'scene', stale: false, textHash: 'abc', updatedAt: 'T' });
    assert.deepEqual(message.swipe_info[1].extra.conductor, message.extra.conductor);
    assert.notEqual(message.swipe_info[1].extra.conductor, message.extra.conductor);
    assert.equal(message.swipe_info[1].extra.other, 1);
    assert.equal(message.swipe_info[0].extra.conductor, undefined);
});

test('writeRecord works on messages without swipes', () => {
    const message = { mes: 'x' };
    writeRecord(message, makeRecord({ state: emptyState(), source: 'scene' }));
    assert.equal(message.extra.conductor.source, 'scene');
});

test('hashText is stable and isFresh compares hashes', () => {
    assert.equal(hashText('abc'), hashText('abc'));
    assert.notEqual(hashText('abc'), hashText('abd'));
    assert.match(hashText(''), /^[0-9a-f]{8}$/);
    assert.equal(isFresh({ state: {}, textHash: 'h' }, 'h'), true);
    assert.equal(isFresh({ state: {}, textHash: 'h' }, 'x'), false);
    assert.equal(isFresh(undefined, 'h'), false);
});

test('parseSceneSet splits on the first =', () => {
    assert.deepEqual(parseSceneSet('location=roof = top'), { path: 'location', value: 'roof = top' });
    assert.deepEqual(parseSceneSet('  present.Ellen.outfit = coat '), { path: 'present.Ellen.outfit', value: 'coat' });
    assert.equal(parseSceneSet('location'), null);
    assert.equal(parseSceneSet('=x'), null);
});

test('applyFieldEdit sets simple fields and threads', () => {
    const state = validateState(good).state;
    assert.equal(applyFieldEdit(state, 'location', 'roof').state.location, 'roof');
    assert.deepEqual(applyFieldEdit(state, 'threads', 'a; b ;').state.threads, ['a', 'b']);
    assert.equal(state.location, 'kitchen');
});

test('applyFieldEdit sets attributes, adding the person if needed, and removes people', () => {
    const state = validateState(good).state;
    const added = applyFieldEdit(state, 'present.Lycaon.mood', 'calm').state;
    assert.deepEqual(added.present[1], { name: 'Lycaon', outfit: '', condition: '', mood: 'calm' });
    const changed = applyFieldEdit(state, 'present.ellen.outfit', 'coat').state;
    assert.equal(changed.present[0].outfit, 'coat');
    const removed = applyFieldEdit(state, 'present.Ellen', '').state;
    assert.deepEqual(removed.present, []);
});

test('applyFieldEdit handles names with dots and spaces', () => {
    const edited = applyFieldEdit(emptyState(), 'present.Dr. Kim.outfit', 'lab coat');
    assert.deepEqual(edited.state.present, [{ name: 'Dr. Kim', outfit: 'lab coat', condition: '', mood: '' }]);
    const parsed = parseSceneSet('present.Dr. Kim.outfit=lab coat');
    assert.deepEqual(parsed, { path: 'present.Dr. Kim.outfit', value: 'lab coat' });
});

test('applyFieldEdit rejects unknown paths', () => {
    assert.equal(applyFieldEdit(emptyState(), 'weather', 'rain').ok, false);
    assert.equal(applyFieldEdit(emptyState(), 'present.', 'x').ok, false);
    assert.equal(applyFieldEdit(emptyState(), 'present.Ellen', 'here').ok, false);
});
