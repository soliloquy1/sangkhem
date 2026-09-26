export function reportLine(report) {
    const ms = report.status === 'ran' || report.status === 'failed' ? `, ${report.ms} ms` : '';
    const detail = report.summary ?? report.reason ?? '';
    return `${report.id}: ${report.status}${ms}${detail ? ` — ${detail}` : ''}`;
}

export function statsLines(summary) {
    if (!summary.turns) return ['No turns yet this session.'];
    return [
        `${summary.turns} turn(s). Plan time p50 ${summary.plan.p50} ms, p95 ${summary.plan.p95} ms.`,
        ...Object.entries(summary.stages).map(([id, s]) => `${id}: p50 ${s.p50} ms, p95 ${s.p95} ms (${s.n} runs)`),
        `Brief adds ~${summary.avgBriefTokens} tokens per turn; lore pruning removes ~${summary.avgDroppedTokens}.`,
    ];
}

export function briefDoubleWarning(mode, promptTexts) {
    if (mode !== 'auto') return null;
    const used = promptTexts.some((text) => typeof text === 'string' && text.includes('{{conductor_brief}}'));
    return used ? 'Your preset uses {{conductor_brief}} and auto-inject is on, so the brief is sent twice. Switch the brief to macro mode.' : null;
}

export function cacheHint({ source, model, protectCachePrefix }) {
    if (protectCachePrefix) return null;
    const claude = source === 'claude' || /claude|anthropic/i.test(model ?? '');
    return claude ? 'If you use prompt caching with Claude, turn on "Protect cache prefix" so lore pruning does not break the cache.' : null;
}

export function provenanceText(entry) {
    if (!entry) return '';
    if (entry.manual) return 'set by hand';
    return `message #${entry.mesId}: "${entry.quote}"`;
}
