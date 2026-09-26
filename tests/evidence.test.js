
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, verifyQuote, quoteProblem, diffPaths, applyEvidenceGate } from '../src/evidence.js';
import { validateState } from '../src/state.js';

const S = (raw) => validateState(raw, { threadsCap: 99 }).state;
const prev = S({
    location: 'kitchen', time: 'night',
    present: [{ name: 'Ellen', outfit: 'hoodie', mood: 'annoyed' }, { name: 'Lycaon' }],
    threads: ['owes a favor', 'plushie missing'],
});

test('normalize lowercases, unifies quotes and whitespace, and drops markdown emphasis', () => {
    assert.equal(normalize('  *She  SMILES*\n“hi” ‘x’ … 「a」'), 'she smiles "hi" \'x\' ... "a"');
});

test('normalize maps full-width punctuation and letters to ASCII', () => {
    assert.equal(normalize('走吧，她说！ＯＫ'), '走吧,她说!ok');
});

test('verifyQuote needs a real, long-enough substring', () => {
    const hay = normalize('*Ellen pulls on the red coat.* "Let\'s go," she says.');
    assert.equal(verifyQuote('pulls on the red coat', hay), true);
    assert.equal(verifyQuote('"Ellen pulls on the red coat."', hay), true);
    assert.equal(verifyQuote('puts on a blue coat', hay), false);
    assert.equal(verifyQuote(null, hay), false);
});

test('single English words are too short to count as evidence', () => {
    const hay = normalize('She smiles at the rooftop door.');
    assert.equal(quoteProblem('the', hay), 'quote too short');
    assert.equal(quoteProblem('rooftop', hay), 'quote too short');
    assert.equal(quoteProblem('rooftop door', hay), null);
    assert.equal(quoteProblem(undefined, hay), 'no quote');
});

test('verifyQuote works for CJK text and corner brackets', () => {
    const hay = normalize('艾伦穿上了红色外套。「走吧」她说。');
    assert.equal(verifyQuote('穿上了红色外套', hay), true);
    assert.equal(verifyQuote('「走吧」她说', hay), true);
    assert.equal(verifyQuote('穿上了蓝色外套', hay), false);
    assert.equal(verifyQuote('走吧', hay), false);
});

test('a quote with ASCII punctuation matches full-width punctuation in the reply', () => {
    assert.equal(verifyQuote('走吧,她说', normalize('「走吧，她说。」')), true);
});

test('diffPaths lists every changed path', () => {
    const next = S({
        location: 'rooftop', time: 'night',
        present: [{ name: 'Ellen', outfit: 'red coat', mood: 'annoyed' }, { name: 'Anby' }],
        threads: ['owes a favor', 'meet at dawn'],
    });
    assert.deepEqual(diffPaths(prev, next).sort(), [
        'location', 'present.Anby', 'present.Ellen.outfit', 'present.Lycaon', 'threads.meet at dawn', 'threads.plushie missing',
    ].sort());
});

test('diffPaths is empty when nothing changed, ignoring case and spacing', () => {
    const same = S({ ...prev, location: 'Kitchen ' });
    assert.deepEqual(diffPaths(prev, same), []);
});

test('the gate accepts changes with verified quotes and records provenance', () => {
    const next = S({ ...prev, location: 'rooftop' });
    const gate = applyEvidenceGate({
        prev, next, evidence: { location: 'they climb onto the rooftop' },
        sources: ['', 'Together they climb onto the rooftop.'], mesId: 12,
    });
    assert.equal(gate.state.location, 'rooftop');
    assert.deepEqual(gate.accepted, ['location']);
    assert.deepEqual(gate.provenance.location, { mesId: 12, quote: 'they climb onto the rooftop' });
});

test('the gate reverts changes with missing or invented quotes', () => {
    const next = S({ ...prev, location: 'rooftop', time: 'dawn' });
    const gate = applyEvidenceGate({
        prev, next, evidence: { time: 'the sun rises' },
        sources: ['hi', 'They talk quietly.'], mesId: 3,
    });
    assert.equal(gate.state.location, 'kitchen');
    assert.equal(gate.state.time, 'night');
    assert.deepEqual(gate.rejected, [
        { path: 'location', reason: 'no quote' },
        { path: 'time', reason: 'quote not found in messages' },
    ]);
});

test('unchanged fields need no quote and keep their old provenance', () => {
    const gate = applyEvidenceGate({
        prev, next: prev, evidence: {}, sources: ['x'], mesId: 5,
        prevProvenance: { location: { mesId: 1, quote: 'in the kitchen' } },
    });
    assert.deepEqual(gate.state, prev);
    assert.deepEqual(gate.rejected, []);
    assert.deepEqual(gate.provenance, { location: { mesId: 1, quote: 'in the kitchen' } });
});

test('people entering, leaving and changing are each gated', () => {
    const next = S({
        ...prev,
        present: [{ name: 'Ellen', outfit: 'red coat', mood: 'happy' }, { name: 'Anby', outfit: 'jacket', mood: 'bored' }],
    });
    const reply = 'Lycaon leaves the room. Anby walks in wearing her jacket. Ellen pulls on a red coat.';
    const gate = applyEvidenceGate({
        prev, next, sources: ['', reply], mesId: 9,
        evidence: {
            'present.Lycaon': 'Lycaon leaves the room',
            'present.Anby': 'Anby walks in',
            'present.Anby.outfit': 'wearing her jacket',
            'present.Anby.mood': 'yawning',
            'present.Ellen.outfit': 'pulls on a red coat',
        },
    });
    assert.deepEqual(gate.state.present, [
        { name: 'Ellen', outfit: 'red coat', condition: '', mood: 'annoyed' },
        { name: 'Anby', outfit: 'jacket', condition: '', mood: '' },
    ]);
    assert.deepEqual(gate.rejected.map((r) => r.path).sort(), ['present.Anby.mood', 'present.Ellen.mood']);
});

test('removing a person drops their provenance', () => {
    const next = S({ ...prev, present: [prev.present[0]] });
    const gate = applyEvidenceGate({
        prev, next, sources: ['Lycaon heads out.'], mesId: 4,
        evidence: { 'present.Lycaon': 'Lycaon heads out' },
        prevProvenance: { 'present.Lycaon': { mesId: 1, quote: 'x' }, 'present.Lycaon.mood': { mesId: 1, quote: 'y' } },
    });
    assert.deepEqual(gate.state.present.map((p) => p.name), ['Ellen']);
    assert.deepEqual(gate.provenance, {});
});

test('threads opened and closed are each gated', () => {
    const next = S({ ...prev, threads: ['owes a favor', 'meet at dawn', 'find the key'] });
    const gate = applyEvidenceGate({
        prev, next, sources: ['', 'She finds the plushie under the bed. "Meet me at dawn."'], mesId: 7,
        evidence: { 'threads.plushie missing': 'finds the plushie', 'threads.meet at dawn': 'Meet me at dawn' },
    });
    assert.deepEqual(gate.state.threads, ['owes a favor', 'meet at dawn']);
    assert.deepEqual(gate.rejected, [{ path: 'threads.find the key', reason: 'no quote' }]);
});

test('new threads over the cap are refused visibly, without provenance', () => {
    const next = S({ ...prev, threads: ['owes a favor', 'plushie missing', 'meet at dawn'] });
    const gate = applyEvidenceGate({
        prev, next, sources: ['"Meet me at dawn."'], mesId: 8, threadsCap: 2,
        evidence: { 'threads.meet at dawn': 'Meet me at dawn' },
    });
    assert.deepEqual(gate.state.threads, ['owes a favor', 'plushie missing']);
    assert.deepEqual(gate.rejected, [{ path: 'threads.meet at dawn', reason: 'over thread cap' }]);
    assert.deepEqual(gate.accepted, []);
    assert.equal('threads.meet at dawn' in gate.provenance, false);
});

test('closing a thread makes room under the cap', () => {
    const next = S({ ...prev, threads: ['owes a favor', 'meet at dawn'] });
    const gate = applyEvidenceGate({
        prev, next, sources: ['She finds the plushie. "Meet me at dawn."'], mesId: 8, threadsCap: 2,
        evidence: { 'threads.plushie missing': 'finds the plushie', 'threads.meet at dawn': 'Meet me at dawn' },
    });
    assert.deepEqual(gate.state.threads, ['owes a favor', 'meet at dawn']);
});

test('evidence keys match case-insensitively', () => {
    const next = S({ ...prev, location: 'rooftop' });
    const gate = applyEvidenceGate({ prev, next, evidence: { LOCATION: 'on the rooftop' }, sources: ['on the rooftop'], mesId: 1 });
    assert.equal(gate.state.location, 'rooftop');
});

test('a non-object evidence value rejects every change', () => {
    const next = S({ ...prev, location: 'rooftop' });
    const gate = applyEvidenceGate({ prev, next, evidence: 'trust me', sources: ['rooftop'], mesId: 1 });
    assert.equal(gate.state.location, 'kitchen');
});

