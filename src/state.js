export const SCHEMA_VERSION = 1;
export const PERSON_ATTRS = ['outfit', 'condition', 'mood'];
export const FIELDS = ['location', 'time', 'present', 'threads'];

/** @returns {{ v: number, location: string, time: string, present: object[], threads: string[] }} */
export function emptyState() {
    return { v: SCHEMA_VERSION, location: '', time: '', present: [], threads: [] };
}

// String fields: trimmed string, '' for missing, null for a wrong type.
const asString = (value) => (typeof value === 'string' ? value.trim() : value == null ? '' : null);
const key = (text) => text.trim().toLowerCase();

/**
 * Checks and normalises a scene state from a model or a chat file.
 * @returns {{ ok: true, state: object, warnings: string[] } | { ok: false, error: string }}
 */
export function validateState(raw, { threadsCap = 8 } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'state is not an object' };
    const warnings = [];
    const state = emptyState();
    for (const field of ['location', 'time']) {
        const value = asString(raw[field]);
        if (value === null) return { ok: false, error: `${field} is not a string` };
        state[field] = value;
    }

    const present = raw.present ?? [];
    if (!Array.isArray(present)) return { ok: false, error: 'present is not an array' };
    const names = new Set();
    for (const person of present) {
        if (!person || typeof person !== 'object') return { ok: false, error: 'present has an entry that is not an object' };
        const name = asString(person.name);
        if (!name) {
            warnings.push('dropped a present entry with no name');
            continue;
        }
        if (names.has(key(name))) {
            warnings.push(`dropped duplicate present entry "${name}"`);
            continue;
        }
        names.add(key(name));
        const entry = { name };
        for (const attr of PERSON_ATTRS) {
            const value = asString(person[attr]);
            if (value === null) return { ok: false, error: `present.${name}.${attr} is not a string` };
            entry[attr] = value;
        }
        state.present.push(entry);
    }

    const threads = raw.threads ?? [];
    if (!Array.isArray(threads)) return { ok: false, error: 'threads is not an array' };
    const seen = new Set();
    for (const thread of threads) {
        const value = asString(thread);
        if (value === null) return { ok: false, error: 'threads has an entry that is not a string' };
        if (!value || seen.has(key(value))) continue;
        seen.add(key(value));
        state.threads.push(value);
    }
    if (state.threads.length > threadsCap) {
        warnings.push(`kept the first ${threadsCap} of ${state.threads.length} threads`);
        state.threads = state.threads.slice(0, threadsCap);
    }
    return { ok: true, state, warnings };
}

export const isAiMessage = (message) => Boolean(message) && !message.is_user && !message.is_system;

/** Index of the latest AI message before `before`, or -1. */
export function latestAiIndex(chat, before = chat.length) {
    for (let i = Math.min(before, chat.length) - 1; i >= 0; i--) {
        if (isAiMessage(chat[i])) return i;
    }
    return -1;
}

/** Index of the user message directly answered by chat[index], or -1 (e.g. consecutive group replies). */
export function previousUserIndex(chat, index) {
    for (let i = index - 1; i >= 0; i--) {
        if (chat[i]?.is_user) return i;
        if (isAiMessage(chat[i])) return -1;
    }
    return -1;
}

/**
 * Scene state from the latest AI message before `before` that holds a valid record.
 * @returns {{ state: object, record: object|null, index: number }}
 */
export function readState(chat, { before = chat.length } = {}) {
    for (let i = Math.min(before, chat.length) - 1; i >= 0; i--) {
        const record = chat[i]?.extra?.conductor;
        if (!isAiMessage(chat[i]) || !record?.state) continue;
        const checked = validateState(record.state, { threadsCap: Infinity });
        if (checked.ok) return { state: checked.state, record, index: i };
    }
    return { state: emptyState(), record: null, index: -1 };
}

export function makeRecord({ state, provenance = {}, source, stale = false, textHash = null, now = () => new Date().toISOString() }) {
    return { state, provenance, source, stale, textHash, updatedAt: now() };
}

/**
 * Stores a record on the message and on its active swipe. ST snapshots message.extra into
 * swipe_info when the reply is saved, which is before Observe finishes, so both are written.
 */
export function writeRecord(message, record) {
    message.extra ??= {};
    message.extra.conductor = record;
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[message.swipe_id ?? 0] : null;
    if (info && typeof info === 'object') {
        info.extra ??= {};
        info.extra.conductor = structuredClone(record);
    }
}

/** FNV-1a 32-bit hash as 8 hex characters. */
export function hashText(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export const isFresh = (record, textHash) => Boolean(record?.state) && record.textHash === textHash;

/** "path=value" → { path, value }, or null. */
export function parseSceneSet(arg) {
    const text = String(arg ?? '');
    const at = text.indexOf('=');
    if (at <= 0) return null;
    const path = text.slice(0, at).trim();
    if (!path) return null;
    return { path, value: text.slice(at + 1).trim() };
}

function parsePresentPath(rest) {
    for (const attr of PERSON_ATTRS) {
        if (rest.toLowerCase().endsWith(`.${attr}`)) return { name: rest.slice(0, -(attr.length + 1)).trim(), attr };
    }
    return { name: rest.trim(), attr: null };
}

/**
 * Applies one manual edit. Paths: location, time, threads ("a; b"), present.<Name>.<attr>=value
 * (adds the person if missing), present.<Name>= (empty value removes the person).
 */
export function applyFieldEdit(state, path, value) {
    const next = structuredClone(state);
    if (path === 'location' || path === 'time') {
        next[path] = value.trim();
        return { ok: true, state: next };
    }
    if (path === 'threads') {
        next.threads = value.split(';').map((t) => t.trim()).filter(Boolean);
        return { ok: true, state: next };
    }
    if (path.startsWith('present.')) {
        const { name, attr } = parsePresentPath(path.slice('present.'.length));
        if (!name) return { ok: false, error: 'missing character name after present.' };
        const index = next.present.findIndex((p) => key(p.name) === key(name));
        if (!attr) {
            if (value.trim()) return { ok: false, error: `use present.${name}= (empty) to remove, or present.${name}.outfit=... to set` };
            if (index >= 0) next.present.splice(index, 1);
            return { ok: true, state: next };
        }
        if (index >= 0) next.present[index][attr] = value.trim();
        else next.present.push({ name, outfit: '', condition: '', mood: '', [attr]: value.trim() });
        return { ok: true, state: next };
    }
    return { ok: false, error: `unknown scene path "${path}"` };
}
