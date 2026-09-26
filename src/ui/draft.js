import { validateState, PERSON_ATTRS } from '../state.js';

const key = (text) => text.trim().toLowerCase();
const byName = (people) => new Map(people.map((p) => [key(p.name), p]));

/**
 * Applies only what the user changed in a scene draft (original → draft) onto the current state, so
 * fields an extraction updated while the draft was open are kept.
 * @returns {{ ok: true, state: object } | { ok: false, error: string }}
 */
export function applyDraftChanges(original, draftRaw, current) {
    const checked = validateState(draftRaw, { threadsCap: Infinity });
    if (!checked.ok) return checked;
    const draft = checked.state;
    const next = structuredClone(current);

    for (const field of ['location', 'time']) {
        if (draft[field] !== original[field]) next[field] = draft[field];
    }

    const before = byName(original.present);
    const after = byName(draft.present);
    next.present = next.present.filter((p) => !(before.has(key(p.name)) && !after.has(key(p.name))));
    for (const [id, person] of after) {
        const old = before.get(id);
        const target = next.present.find((p) => key(p.name) === id);
        const changed = old ? PERSON_ATTRS.filter((attr) => old[attr] !== person[attr]) : PERSON_ATTRS;
        if (old && !changed.length) continue;
        if (!target) {
            next.present.push(structuredClone(person));
            continue;
        }
        for (const attr of changed) target[attr] = person[attr];
    }

    const originalThreads = new Set(original.threads.map(key));
    const draftThreads = new Set(draft.threads.map(key));
    next.threads = next.threads.filter((t) => !(originalThreads.has(key(t)) && !draftThreads.has(key(t))));
    const kept = new Set(next.threads.map(key));
    for (const thread of draft.threads) {
        if (!originalThreads.has(key(thread)) && !kept.has(key(thread))) next.threads.push(thread);
    }
    return { ok: true, state: next };
}
