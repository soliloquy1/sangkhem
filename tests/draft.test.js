import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDraftChanges } from '../src/ui/draft.js';
import { validateState } from '../src/state.js';

const S = (raw) => validateState(raw, { threadsCap: 99 }).state;

test('keeps fields an extraction changed while the draft was open', () => {
    const original = S({ location: 'kitchen', present: [{ name: 'Ellen', outfit: 'hoodie' }], threads: ['t1'] });
    const draft = { ...original, location: 'rooftop' };
    const current = S({ location: 'kitchen', present: [{ name: 'Ellen', outfit: 'red coat' }, { name: 'Lycaon' }], threads: ['t1', 't2'] });
    const result = applyDraftChanges(original, draft, current);
    assert.equal(result.ok, true);
    assert.deepEqual(result.state, S({
        location: 'rooftop', present: [{ name: 'Ellen', outfit: 'red coat' }, { name: 'Lycaon' }], threads: ['t1', 't2'],
    }));
});

test('applies the user\'s own attribute edits, removals and additions', () => {
    const original = S({ time: 'night', present: [{ name: 'Ellen', outfit: 'hoodie', mood: 'bored' }, { name: 'Lycaon' }], threads: ['a', 'b'] });
    const draft = {
        ...original,
        present: [{ name: 'Ellen', outfit: 'coat', mood: 'bored' }, { name: 'Anby', outfit: 'jacket' }],
        threads: ['a', 'c', ''],
    };
    const current = S({ ...original, time: 'dawn', present: [{ name: 'Ellen', outfit: 'hoodie', mood: 'annoyed' }, { name: 'Lycaon' }] });
    const result = applyDraftChanges(original, draft, current);
    assert.deepEqual(result.state, S({
        time: 'dawn',
        present: [{ name: 'Ellen', outfit: 'coat', mood: 'annoyed' }, { name: 'Anby', outfit: 'jacket' }],
        threads: ['a', 'c'],
    }));
});

test('re-adds a person the extraction removed if the user edited them', () => {
    const original = S({ present: [{ name: 'Lycaon' }] });
    const draft = S({ present: [{ name: 'Lycaon', mood: 'calm' }] });
    const current = S({ present: [] });
    assert.deepEqual(applyDraftChanges(original, draft, current).state.present, [{ name: 'Lycaon', outfit: '', condition: '', mood: 'calm' }]);
});

test('an unchanged draft leaves the current state as it is', () => {
    const original = S({ location: 'kitchen', threads: ['a'] });
    const current = S({ location: 'rooftop', threads: ['a', 'b'] });
    assert.deepEqual(applyDraftChanges(original, structuredClone(original), current).state, current);
});

test('an invalid draft is refused', () => {
    assert.equal(applyDraftChanges(S({}), { location: 5 }, S({})).ok, false);
});
