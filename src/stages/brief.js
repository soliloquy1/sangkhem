import { PERSON_ATTRS } from '../state.js';
import { DEFAULT_BRIEF_TEMPLATE } from '../settings.js';

/** One line per non-empty, enabled field. */
export function renderSceneLines(state, fields = {}) {
    const on = (field) => fields?.[field] !== false;
    const lines = [];
    if (on('location') && state.location) lines.push(`Location: ${state.location}`);
    if (on('time') && state.time) lines.push(`Time: ${state.time}`);
    if (on('present') && state.present.length) {
        const people = state.present.map((person) => {
            const attrs = PERSON_ATTRS.map((attr) => person[attr]).filter(Boolean);
            return attrs.length ? `${person.name} (${attrs.join('; ')})` : person.name;
        });
        lines.push(`Present: ${people.join(', ')}`);
    }
    if (on('threads') && state.threads.length) lines.push(`Open threads: ${state.threads.join('; ')}`);
    return lines;
}

export function renderSceneLine(state, fields) {
    return renderSceneLines(state, fields).join(' | ');
}

/** The brief block, or '' when there is nothing to say. */
export function renderBrief(state, { template, fields } = {}) {
    const lines = renderSceneLines(state, fields);
    if (!lines.length) return '';
    const body = lines.join('\n');
    const tpl = template || DEFAULT_BRIEF_TEMPLATE;
    // Function replacer: scene text may contain "$&" and similar patterns.
    return tpl.includes('{{scene}}') ? tpl.replace('{{scene}}', () => body) : `${tpl}\n${body}`;
}

/**
 * @param {{ briefStore: { value: string }, setPrompt: (text: string, depth: number) => void }} deps
 */
export function createBriefStage({ briefStore, setPrompt }) {
    return {
        id: 'brief',
        phase: 'plan',
        // Only string rendering: it must still run when the observe wait used up the plan budget.
        budgetExempt: true,
        async run(turn, state, config) {
            const fields = turn.settings?.stages?.scene?.fields;
            const brief = renderBrief(state, { template: config.template, fields });
            briefStore.value = brief;
            setPrompt(config.mode === 'macro' ? '' : brief, config.depth);
            const lines = renderSceneLines(state, fields).length;
            return { output: { brief }, summary: brief ? `${lines} lines, ${config.mode}` : 'no scene state yet' };
        },
    };
}
