import { PERSON_ATTRS } from './state.js';

// A quote must be specific enough to point at one change: two words in space-separated text,
// three characters in scripts written without spaces (Chinese, Japanese, Thai).
export const MIN_WORDS = 2;
export const MIN_UNSPACED_CHARS = 3;
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * NFKC (full-width punctuation and letters become ASCII, … becomes ...), lowercase, straight quotes
 * (curly quotes and CJK corner brackets), single spaces, no markdown emphasis characters.
 */
export function normalize(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[‘’‚‛]/g, "'")
        .replace(/[“”„‟「」『』]/g, '"')
        .replace(/[*_]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export function quoteIsSpecific(needle) {
    if (UNSPACED.test(needle)) return [...needle].length >= MIN_UNSPACED_CHARS;
    return needle.split(' ').filter(Boolean).length >= MIN_WORDS;
}

/**
 * null when the quote (minus wrapping quote marks) is specific and appears in the normalised
 * haystack; otherwise why it does not count. This proves the quote exists in the messages,
 * not that it supports the change.
 */
export function quoteProblem(quote, haystack) {
    if (typeof quote !== 'string') return 'no quote';
    const needle = normalize(quote).replace(/^["']+|["']+$/g, '').trim();
    if (!quoteIsSpecific(needle)) return 'quote too short';
    return haystack.includes(needle) ? null : 'quote not found in messages';
}

export const verifyQuote = (quote, haystack) => quoteProblem(quote, haystack) === null;

const personKey = (name) => name.trim().toLowerCase();
const same = (a, b) => normalize(a) === normalize(b);

/** Field paths where next differs from prev. */
export function diffPaths(prev, next) {
    const paths = [];
    for (const field of ['location', 'time']) if (!same(prev[field], next[field])) paths.push(field);
    const before = new Map(prev.present.map((p) => [personKey(p.name), p]));
    const after = new Map(next.present.map((p) => [personKey(p.name), p]));
    for (const [id, person] of before) if (!after.has(id)) paths.push(`present.${person.name}`);
    for (const [id, person] of after) {
        const old = before.get(id);
        if (!old) paths.push(`present.${person.name}`);
        for (const attr of PERSON_ATTRS) if (!same(old?.[attr], person[attr])) paths.push(`present.${person.name}.${attr}`);
    }
    const oldThreads = new Set(prev.threads.map(normalize));
    const newThreads = new Set(next.threads.map(normalize));
    for (const thread of prev.threads) if (!newThreads.has(normalize(thread))) paths.push(`threads.${thread}`);
    for (const thread of next.threads) if (!oldThreads.has(normalize(thread))) paths.push(`threads.${thread}`);
    return paths;
}

function findQuote(evidence, path) {
    if (!evidence || typeof evidence !== 'object') return null;
    if (typeof evidence[path] === 'string') return evidence[path];
    const wanted = normalize(path);
    for (const [key, value] of Object.entries(evidence)) {
        if (typeof value === 'string' && normalize(key) === wanted) return value;
    }
    return null;
}

function dropProvenance(provenance, prefix) {
    for (const key of Object.keys(provenance)) {
        if (key === prefix || key.startsWith(`${prefix}.`)) delete provenance[key];
    }
}

/**
 * Keeps only the changes backed by a quote that really appears in the new messages.
 * Unchanged fields need no quote. Rejected changes keep the previous value. New threads beyond
 * threadsCap are refused (reported as "over thread cap"); closing old threads makes room.
 */
export function applyEvidenceGate({ prev, next, evidence, sources, mesId, prevProvenance = {}, threadsCap = Infinity }) {
    const haystack = normalize(sources.filter(Boolean).join('\n'));
    const accepted = [];
    const rejected = [];
    const provenance = { ...prevProvenance };
    const allow = (path) => {
        const quote = findQuote(evidence, path);
        const problem = quoteProblem(quote, haystack);
        if (problem === null) {
            accepted.push(path);
            provenance[path] = { mesId, quote: quote.trim() };
            return true;
        }
        rejected.push({ path, reason: problem });
        return false;
    };

    const state = structuredClone(prev);
    for (const field of ['location', 'time']) {
        if (!same(prev[field], next[field]) && allow(field)) state[field] = next[field];
    }

    const after = new Map(next.present.map((p) => [personKey(p.name), p]));
    state.present = state.present.filter((person) => {
        if (after.has(personKey(person.name))) return true;
        if (!allow(`present.${person.name}`)) return true;
        dropProvenance(provenance, `present.${person.name}`);
        return false;
    });
    for (const person of state.present) {
        const updated = after.get(personKey(person.name));
        if (!updated) continue;
        for (const attr of PERSON_ATTRS) {
            if (!same(person[attr], updated[attr]) && allow(`present.${person.name}.${attr}`)) person[attr] = updated[attr];
        }
    }
    const before = new Set(prev.present.map((p) => personKey(p.name)));
    for (const person of next.present) {
        if (before.has(personKey(person.name)) || !allow(`present.${person.name}`)) continue;
        const entry = { name: person.name, outfit: '', condition: '', mood: '' };
        for (const attr of PERSON_ATTRS) {
            if (person[attr] && allow(`present.${person.name}.${attr}`)) entry[attr] = person[attr];
        }
        state.present.push(entry);
    }

    const nextThreads = new Set(next.threads.map(normalize));
    state.threads = state.threads.filter((thread) => {
        if (nextThreads.has(normalize(thread))) return true;
        if (!allow(`threads.${thread}`)) return true;
        delete provenance[`threads.${thread}`];
        return false;
    });
    const prevThreads = new Set(prev.threads.map(normalize));
    for (const thread of next.threads) {
        if (prevThreads.has(normalize(thread))) continue;
        if (state.threads.length >= threadsCap) {
            rejected.push({ path: `threads.${thread}`, reason: 'over thread cap' });
            continue;
        }
        if (allow(`threads.${thread}`)) state.threads.push(thread);
    }

    return { state, provenance, accepted, rejected };
}