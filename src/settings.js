export const MODULE_NAME = 'sangkhem';
export const LOG_PREFIX = '[sangkhem]';

export const DEFAULT_BRIEF_TEMPLATE = [
    '<scene_notes>',
    'Tracked scene notes. If the story so far says otherwise, the story wins.',
    '{{scene}}',
    '</scene_notes>',
].join('\n');

export const DEFAULTS = {
    enabled: true,
    planBudgetMs: 8000,
    observeTrigger: 'settled', // 'settled' | 'commit'
    settleMs: 1500,
    observeWaitMs: 4000,
    failureToastAfter: 3,
    stages: {
        memory: {
            enabled: true,
            backend: 'summaryception',
            timeoutMs: 500,
        },
        lore: {
            enabled: true,
            backend: 'laya',
            timeoutMs: 5000,
            serviceUrl: 'http://localhost:8666',
            maxCandidates: 25,
            budgetTokens: 1024,
            recentTurns: 4,
            wRelevance: 1,
            wUsefulness: 1,
            minScore: 1,
            protectCachePrefix: false,
        },
        brief: {
            enabled: true,
            mode: 'auto', // 'auto' | 'macro'
            depth: 1,
            template: DEFAULT_BRIEF_TEMPLATE,
            timeoutMs: 500,
        },
        scene: {
            enabled: true,
            profileId: '',
            timeoutMs: 20000,
            maxTokens: 800,
            temperature: 0, // pinned so the eval tool measures the same settings as the extension
            threadsCap: 8,
            storyTags: 'content',
            fields: { location: true, time: true, present: true, threads: true },
        },
    },
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Deep-merges saved settings over the defaults. Saved values of the wrong type are ignored;
 * unknown saved keys are kept.
 * @param {any} saved
 * @param {object} [defaults]
 * @returns {object}
 */
export function mergeDefaults(saved, defaults = DEFAULTS) {
    const out = structuredClone(defaults);
    if (!isPlainObject(saved)) return out;
    for (const [key, value] of Object.entries(saved)) {
        if (!(key in out)) {
            out[key] = value;
        } else if (isPlainObject(out[key])) {
            if (isPlainObject(value)) out[key] = mergeDefaults(value, out[key]);
        } else if (typeof value === typeof out[key]) {
            out[key] = value;
        }
    }
    return out;
}

/** @param {object} obj @param {string} path dotted path */
export function getPath(obj, path) {
    return path.split('.').reduce((node, key) => node?.[key], obj);
}

/** @param {object} obj @param {string} path dotted path @param {any} value */
export function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let node = obj;
    for (const key of keys) node = node[key] ??= {};
    node[last] = value;
}
