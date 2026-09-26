import { normalize } from '../src/evidence.js';
import { PERSON_ATTRS } from '../src/state.js';

const words = (text) => new Set(normalize(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(' ').filter(Boolean));
const same = (a, b) => normalize(a) === normalize(b);

/** Loose match: models word things differently, so containment or half the words in common counts. */
export function fieldMatches(expected, actual) {
    const e = normalize(expected);
    const a = normalize(actual);
    if (!e && !a) return true;
    if (!e || !a) return false;
    if (e === a || a.includes(e) || e.includes(a)) return true;
    const ew = words(e);
    const aw = words(a);
    const shared = [...ew].filter((w) => aw.has(w)).length;
    const union = new Set([...ew, ...aw]).size;
    return union > 0 && shared / union >= 0.5;
}

// A field the fixture expects to change only passes if the model changed it: an answer identical to
// the previous value fails even when the loose match would accept it.
function check(field, expected, actual, previous) {
    const changed = !same(expected, previous);
    const ok = fieldMatches(expected, actual) && !(changed && same(actual, previous));
    return { field, changed, ok };
}

/**
 * Checks only the fields present in `expected`. Each check says whether the fixture expects that
 * field to change from `prev` (recall) or stay the same (stability).
 */
export function scoreFixture(expected, actual, prev) {
    const checks = [];
    for (const field of ['location', 'time']) {
        if (field in expected) checks.push(check(field, expected[field], actual[field], prev[field]));
    }
    if (expected.present) {
        const key = (people) => people.map((p) => normalize(p.name)).sort().join('|');
        const actualByName = new Map(actual.present.map((p) => [normalize(p.name), p]));
        const prevByName = new Map(prev.present.map((p) => [normalize(p.name), p]));
        checks.push({
            field: 'present.names',
            changed: key(expected.present) !== key(prev.present),
            ok: key(expected.present) === key(actual.present),
        });
        for (const person of expected.present) {
            for (const attr of PERSON_ATTRS) {
                if (!(attr in person)) continue;
                const name = normalize(person.name);
                checks.push(check(`present.${attr}`, person[attr], actualByName.get(name)?.[attr] ?? '', prevByName.get(name)?.[attr] ?? ''));
            }
        }
    }
    if (expected.threads) {
        for (const thread of expected.threads) {
            checks.push({
                field: 'threads',
                changed: !prev.threads.some((t) => fieldMatches(thread, t)),
                ok: actual.threads.some((t) => fieldMatches(thread, t)),
            });
        }
        checks.push({
            field: 'threads.closed',
            changed: prev.threads.length > expected.threads.length,
            ok: actual.threads.length <= expected.threads.length,
        });
    }
    return checks;
}

const ratio = (checks) => (checks.length ? checks.filter((c) => c.ok).length / checks.length : null);

/** recall: expected changes found; stability: unchanged fields left alone. */
export function summarize(results) {
    const all = results.flatMap((r) => r.checks);
    const byField = {};
    for (const c of all) {
        byField[c.field] ??= { ok: 0, total: 0 };
        byField[c.field].total++;
        if (c.ok) byField[c.field].ok++;
    }
    return {
        recall: ratio(all.filter((c) => c.changed)),
        stability: ratio(all.filter((c) => !c.changed)),
        changes: all.filter((c) => c.changed).length,
        byField,
    };
}
