import { h } from './dom.js';
import { reportLine, statsLines } from './format.js';

const section = (title, lines, extra = null) => h('div', { class: 'sk-section' }, [
    h('b', { text: title }),
    ...lines.map((line) => h('div', { class: 'sk-line', text: line })),
    extra,
]);

export function renderInspector(container, session, summary) {
    const plan = session.lastPlan;
    const planSection = plan
        ? section('Last plan', [`${plan.type}, ${plan.ms} ms, brief ~${plan.briefTokens} tokens`, ...plan.reports.map(reportLine)],
            plan.brief ? h('pre', { class: 'sk-brief', text: plan.brief }) : null)
        : section('Last plan', ['No generation yet.']);

    const observed = session.lastObserve;
    const observeSection = observed
        ? section('Last observe', [
            `message #${observed.mesId}`,
            ...observed.reports.map(reportLine),
            ...(observed.scene?.rejected ?? []).map((r) => `rejected ${r.path}: ${r.reason}`),
            ...(observed.scene?.warnings ?? []),
        ])
        : section('Last observe', ['Nothing observed yet.']);

    container.replaceChildren(planSection, observeSection, section('This session', statsLines(summary)));
}
