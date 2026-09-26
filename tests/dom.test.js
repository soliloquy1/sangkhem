import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h } from '../src/ui/dom.js';

class FakeNode {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.attrs = {};
        this.listeners = {};
        this.ownText = '';
    }
    set innerHTML(_value) { throw new Error('innerHTML must never be used'); }
    set textContent(value) { this.ownText = value; }
    get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    append(...nodes) { this.children.push(...nodes); }
}
const doc = { createElement: (tag) => new FakeNode(tag), createTextNode: (text) => ({ textContent: text, isText: true }) };

test('markup in text stays literal text', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const node = h('div', { text: payload }, [payload], doc);
    assert.equal(node.ownText, payload);
    assert.equal(node.children[0].isText, true);
    assert.equal(node.textContent, payload + payload);
});

test('supports the listed props', () => {
    const onclick = () => {};
    const node = h('input', { class: 'a b', value: 'v', checked: true, type: 'text', 'data-x': 1, rows: 3, onclick }, [], doc);
    assert.equal(node.className, 'a b');
    assert.equal(node.value, 'v');
    assert.equal(node.checked, true);
    assert.deepEqual(node.attrs, { type: 'text', 'data-x': '1', rows: '3' });
    assert.equal(node.listeners.click, onclick);
});

test('skips null children and rejects unknown props', () => {
    assert.equal(h('div', {}, [null, false, 'x'], doc).children.length, 1);
    assert.throws(() => h('div', { innerHTML: '<b>' }, [], doc), /unsupported prop "innerHTML"/);
    assert.throws(() => h('div', { style: 'x' }, [], doc), /unsupported prop/);
});
