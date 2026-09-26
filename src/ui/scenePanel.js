import { h } from './dom.js';
import { provenanceText } from './format.js';
import { PERSON_ATTRS } from '../state.js';

const LABELS = { location: 'Location', time: 'Time' };

/**
 * Editable scene state. Edits stay in a draft until Save; onDirty tells the caller not to re-render
 * over unsaved edits.
 */
export function renderScenePanel(container, { view, fields, onDirty, onSave, onRevert, onRetry, onJump }) {
    if (view.index < 0) {
        container.replaceChildren(h('div', { class: 'sk-muted', text: 'No character message yet.' }));
        return;
    }
    const draft = structuredClone(view.state);
    const on = (field) => fields?.[field] !== false;
    const edit = (apply) => (event) => { apply(event.target.value); onDirty(); };
    const rows = [];

    if (view.stale) {
        rows.push(h('div', { class: 'sk-stale' }, [
            'Out of date: the last extraction failed. ',
            h('button', { class: 'menu_button', type: 'button', onclick: onRetry }, 'Retry'),
        ]));
    }
    if (view.pending) rows.push(h('div', { class: 'sk-muted', text: 'Updating…' }));

    for (const field of ['location', 'time']) {
        if (!on(field)) continue;
        rows.push(h('label', { class: 'sk-field' }, [
            LABELS[field],
            h('input', { class: 'text_pole', type: 'text', value: draft[field], oninput: edit((v) => { draft[field] = v; }) }),
        ]));
    }

    if (on('present')) {
        const list = h('div', { class: 'sk-present' });
        const renderPeople = () => list.replaceChildren(...draft.present.map((person, i) => h('div', { class: 'sk-person' }, [
            h('input', { class: 'text_pole', type: 'text', placeholder: 'name', value: person.name, oninput: edit((v) => { person.name = v; }) }),
            ...PERSON_ATTRS.map((attr) => h('input', {
                class: 'text_pole', type: 'text', placeholder: attr, value: person[attr], oninput: edit((v) => { person[attr] = v; }),
            })),
            h('button', { class: 'menu_button', type: 'button', title: 'Remove', onclick: () => { draft.present.splice(i, 1); onDirty(); renderPeople(); } }, '✕'),
        ])));
        renderPeople();
        rows.push(h('div', { class: 'sk-field' }, [
            'Present',
            list,
            h('button', {
                class: 'menu_button', type: 'button',
                onclick: () => { draft.present.push({ name: '', outfit: '', condition: '', mood: '' }); onDirty(); renderPeople(); },
            }, 'Add person'),
        ]));
    }

    if (on('threads')) {
        rows.push(h('label', { class: 'sk-field' }, [
            'Open threads (one per line)',
            h('textarea', { class: 'text_pole', rows: 4, value: draft.threads.join('\n'), oninput: edit((v) => { draft.threads = v.split('\n'); }) }),
        ]));
    }

    const sources = Object.entries(view.provenance);
    if (sources.length) {
        rows.push(h('details', { class: 'sk-prov' }, [
            h('summary', { text: 'Where these came from' }),
            ...sources.map(([path, entry]) => h('div', { class: 'sk-prov-row' }, [
                `${path}: `,
                entry.manual || entry.mesId == null
                    ? provenanceText(entry)
                    : h('button', { class: 'sk-link', type: 'button', onclick: () => onJump(entry.mesId) }, provenanceText(entry)),
            ])),
        ]));
    }

    rows.push(h('div', { class: 'sk-actions' }, [
        h('button', { class: 'menu_button', type: 'button', onclick: () => onSave(draft) }, 'Save scene'),
        h('button', { class: 'menu_button', type: 'button', onclick: onRevert }, 'Revert'),
    ]));
    container.replaceChildren(...rows);
}
