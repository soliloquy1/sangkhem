import { resolveBackend, BackendUnavailableError } from '../backends/resolve.js';
import { renderSceneLine } from './brief.js';

export const AT_DEPTH_POSITION = 4; // world_info_position.atDepth in public/scripts/world-info.js
export const MAX_ENTRY_CHARS = 1600;
// Laya reads at most 1024 tokens: the question, the entry and this context together.
export const SCORER_CONTEXT_CHARS = 1600;
export const MESSAGE_CHARS = 600;
export const SUMMARY_CHARS = 400;

export const entryId = (entry) => `${entry.world}.${entry.uid}`;

/** Entries the scorer may judge: not constant, not disabled, not empty; @depth only when protecting the cache prefix. */
export function selectCandidates(activated, { maxCandidates, protectCachePrefix }) {
    const judgeable = activated.filter((entry) => !entry.constant && !entry.disable && (entry.content ?? '').trim()
        && (!protectCachePrefix || entry.position === AT_DEPTH_POSITION));
    return { pool: judgeable.slice(0, maxCandidates), total: judgeable.length };
}

/**
 * Ranks by weighted score and greedily fills the token budget. Entries the scorer returned no
 * score for are kept without being charged to the budget, so they cannot crowd out scored ones.
 */
export function rankAndFill(pool, scores, { wRelevance, wUsefulness, minScore, budgetTokens }, tokensOf) {
    const scoreById = new Map(scores.map((s) => [s.id, wRelevance * s.relevance + wUsefulness * s.usefulness]));
    const ranked = pool
        .map((entry) => ({ entry, id: entryId(entry), score: scoreById.get(entryId(entry)) ?? Infinity }))
        .sort((a, b) => b.score - a.score);
    let budget = budgetTokens;
    const kept = [];
    const dropped = [];
    for (const item of ranked) {
        const tokens = tokensOf(item.entry);
        if (item.score === Infinity) {
            kept.push({ ...item, tokens, unscored: true });
        } else if (item.score < minScore) {
            dropped.push({ ...item, tokens, why: 'low score' });
        } else if (tokens > budget) {
            dropped.push({ ...item, tokens, why: 'over budget' });
        } else {
            budget -= tokens;
            kept.push({ ...item, tokens });
        }
    }
    return { kept, dropped };
}

/** Scene notes, recent summary and recent turns (newest first), trimmed to SCORER_CONTEXT_CHARS. */
export function buildScorerContext({ chatForWI, recentTurns, sceneText, summary }) {
    const recent = [];
    let used = 0;
    const push = (line) => {
        const room = SCORER_CONTEXT_CHARS - used;
        if (!line || room <= 0) return;
        const text = line.length > room ? line.slice(-room) : line;
        recent.push(text);
        used += text.length;
    };
    if (sceneText) push(`Scene: ${sceneText}`);
    if (summary) push(`Story so far: ${summary.slice(-SUMMARY_CHARS)}`);
    for (const line of chatForWI.slice(0, recentTurns)) push(line);
    return { message: (chatForWI[0] ?? '').slice(-MESSAGE_CHARS), recent };
}

/** WORLDINFO_ENTRIES_LOADED handler body: flags suppressed entries before ST's real scan clones them. */
export function applySuppression(data, suppression) {
    if (!suppression.size || !data) return 0;
    let applied = 0;
    for (const list of [data.globalLore, data.characterLore, data.chatLore, data.personaLore]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (suppression.has(entryId(entry))) {
                entry.disable = true;
                applied++;
            }
        }
    }
    return applied;
}

/** True when the standalone Laya WI Director is loaded and pruning lore. */
export function layaDirectorConflict(ctx) {
    if (!ctx?.extensionSettings?.laya_wi_director?.enabled) return false;
    return !(ctx.disabledExtensions ?? []).some((name) => /laya-wi-director$/i.test(name));
}

/**
 * @param {{ scorers: object, scanWorldInfo: Function, countTokens: Function, suppression: Set<string>,
 *   includeNames: () => Promise<boolean> }} deps  includeNames reads ST's own World Info setting.
 */
export function createLoreStage({ scorers, scanWorldInfo, countTokens, suppression, includeNames }) {
    return {
        id: 'lore',
        phase: 'plan',
        available(ctx, config) {
            if (layaDirectorConflict(ctx)) return 'Laya WI Director is pruning lore; turn off its Enable to use this stage';
            const { backend, reason } = resolveBackend(scorers, config.backend, ctx);
            return backend.id === 'none' ? (reason ?? 'lore scorer is set to none') : true;
        },
        async run(turn, state, config) {
            const { backend: scorer, reason } = resolveBackend(scorers, config.backend, turn.ctx);
            if (scorer.id === 'none') return { skip: reason ?? 'lore scorer is set to none' };

            // Same text ST's real scan uses (script.js), newest first, so the dry run matches it.
            const withNames = await includeNames();
            const chatForWI = turn.chat.map((m) => (withNames ? `${m.name}: ${m.mes}` : m.mes)).reverse();
            const activated = await scanWorldInfo(chatForWI, turn.contextSize);
            const { pool, total } = selectCandidates(activated, config);
            if (pool.length <= 1) return { skip: `${pool.length} ${pool.length === 1 ? 'entry' : 'entries'} to judge` };

            const context = buildScorerContext({
                chatForWI, recentTurns: config.recentTurns,
                sceneText: renderSceneLine(state), summary: turn.outputs.memory?.summary ?? null,
            });
            let scores;
            try {
                scores = await scorer.score(
                    pool.map((entry) => ({ id: entryId(entry), content: entry.content.slice(0, MAX_ENTRY_CHARS) })),
                    context,
                    { serviceUrl: config.serviceUrl, signal: turn.signal },
                );
            } catch (error) {
                if (error instanceof BackendUnavailableError) return { skip: error.message };
                throw error;
            }
            const tokens = new Map(await Promise.all(pool.map(async (entry) => [entryId(entry), await countTokens(entry.content)])));
            if (turn.signal?.aborted) return { skip: 'aborted' };

            const { kept, dropped } = rankAndFill(pool, scores, config, (entry) => tokens.get(entryId(entry)));
            for (const item of dropped) suppression.add(item.id);
            const droppedTokens = dropped.reduce((sum, item) => sum + item.tokens, 0);
            return {
                output: { kept: kept.length, dropped: dropped.length, droppedTokens, judged: pool.length, unjudged: total - pool.length },
                summary: `kept ${kept.length}, dropped ${dropped.length}, ~${droppedTokens} tokens saved`,
            };
        },
    };
}
