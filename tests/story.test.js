import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStory, parseTagList } from '../src/story.js';

test('keeps only story-tag content when present', () => {
    const text = '<ellen_planning~>plan</ellen_planning~>\n<content>She smiles.</content>\n<tracker>hp 3</tracker>';
    assert.equal(extractStory(text, ['content']), 'She smiles.');
});

test('without story tags, drops custom-tagged blocks and keeps the rest', () => {
    const text = '<ellen_planning~>\nthinking\n</ellen_planning~>\nShe smiles.\n<details>cot</details>';
    assert.equal(extractStory(text, ['content']), 'She smiles.');
});

test('unwraps plain HTML formatting instead of dropping it', () => {
    assert.equal(extractStory('She <b>really</b> smiles.<br>Then leaves.', []), 'She really smiles. Then leaves.');
});

test('an unclosed custom tag swallows the rest (cut-off CoT)', () => {
    assert.equal(extractStory('<thinking>never closed', []), '');
});

test('handles empty input', () => {
    assert.equal(extractStory('', ['content']), '');
    assert.equal(extractStory(undefined, ['content']), '');
});

test('parseTagList splits a comma list', () => {
    assert.deepEqual(parseTagList(' content, story ,, '), ['content', 'story']);
    assert.deepEqual(parseTagList(''), []);
});
