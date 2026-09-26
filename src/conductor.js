import { runPhase, FailureTracker } from './runner.js';
import {
    readState, latestAiIndex, previousUserIndex, isAiMessage, makeRecord, writeRecord,
    hashText, isFresh, validateState, applyFieldEdit,
} from './state.js';
import { diffPaths } from './evidence.js';
import { extractStory, parseTagList } from './story.js';
import { applySuppression } from './stages/lore.js';
import { ObserveScheduler } from './observe.js';
import { createStats, recordPlan, recordStageTimes } from './stats.js';

// Most AI replies Plan will observe before one generation: one group turn, not a whole old chat.
export const CATCH_UP_LIMIT = 4;

/** What Observe reads for chat[mesId], and the hash that says whether a record is still current. */
export function observeInput(chat, mesId, settings) {
    const userIndex = previousUserIndex(chat, mesId);
    const userText = userIndex >= 0 ? chat[userIndex].mes ?? '' : '';
    const replyText = extractStory(chat[mesId]?.mes ?? '', parseTagList(settings.stages.scene.storyTags));
    return { userText, replyText, textHash: hashText(`${userText}\n${replyText}`) };
}

/**
 * AI replies in the current run (after the last user message, before `before`) whose record is
 * missing or out of date, oldest first. Stops at the first reply with a current record.
 */
export function catchUpIndices(chat, before, settings, limit = CATCH_UP_LIMIT) {
    const indices = [];
    for (let i = Math.min(before, chat.length) - 1; i >= 0 && indices.length < limit; i--) {
        const message = chat[i];
        if (message?.is_user) break;
        if (!isAiMessage(message)) continue;
        if (isFresh(message.extra?.conductor, observeInput(chat, i, settings).textHash)) break;
        indices.push(i);
    }
    return indices.reverse();
}

function ownManualState(message) {
    const own = message.extra?.conductor;
    if (own?.source !== 'manual') return null;
    const checked = validateState(own.state, { threadsCap: Infinity });
    return checked.ok ? { state: checked.state, record: own } : null;
}

export function createConductor({ deps, stages, suppression, briefStore }) {
    const now = deps.now ?? Date.now;
    const failures = new FailureTracker();
    const session = { lastPlan: null, lastObserve: null, stats: createStats() };
    const scheduler = new ObserveScheduler({
        run: (mesId, signal) => observe(mesId, signal),
        onError: (error) => deps.log?.(error),
    });
    let planController = null;
    const settings = () => deps.getSettings();

    function alert(reports) {
        const threshold = settings().failureToastAfter;
        for (const id of failures.record(reports, threshold)) {
            deps.notify(id, reports.find((r) => r.id === id)?.reason ?? 'failed', threshold);
        }
    }

    function clearBrief() {
        briefStore.value = '';
        deps.setBriefPrompt('', settings().stages.brief.depth);
    }

    async function observe(mesId, signal) {
        const current = settings();
        const chatId = deps.getChatId();
        const chat = deps.getChat();
        const message = chat[mesId];
        if (!isAiMessage(message)) return;
        const input = observeInput(chat, mesId, current);
        const recordAtStart = message.extra?.conductor;
        const base = ownManualState(message) ?? readState(chat, { before: mesId });
        const { userName, charName } = deps.names();
        const result = await runPhase(stages, {
            phase: 'observe',
            turn: {
                chat, mesId, ...input, userName, charName: message.name || charName,
                prevProvenance: base.record?.provenance ?? {}, signal, ctx: deps.getContextView(), settings: current,
            },
            state: base.state,
            settings: current,
            now,
        });

        // Discard results for a chat, message or swipe that is no longer the one we read.
        const live = deps.getChat();
        if (signal.aborted || deps.getChatId() !== chatId || live[mesId] !== message) return;
        if (observeInput(live, mesId, current).textHash !== input.textHash) return;
        // Edited by hand while the model was working: the edit wins.
        if (message.extra?.conductor !== recordAtStart) return;

        session.lastObserve = { at: now(), mesId, reports: result.reports, scene: result.outputs.scene ?? null };
        recordStageTimes(session.stats, result.reports);
        alert(result.reports);
        const scene = result.reports.find((r) => r.id === 'scene');
        if (scene?.status === 'ran') {
            writeRecord(message, makeRecord({
                state: result.state, provenance: result.outputs.scene?.provenance ?? {}, source: 'scene', textHash: input.textHash,
            }));
        } else if (scene?.status === 'failed') {
            // Labelled 'scene' even when copied from a manual record: it is not a new edit by the user.
            writeRecord(message, makeRecord({
                state: base.state, provenance: base.record?.provenance ?? {}, source: 'scene',
                stale: true, textHash: input.textHash,
            }));
        } else {
            deps.onUpdate();
            return;
        }
        await deps.saveChat();
        deps.onUpdate();
    }

    // Observes every reply of the current run that is not up to date, oldest first (the scheduler
    // runs them in order), and waits up to observeWaitMs for the last one.
    async function ensureObserved(chat, before, current) {
        if (current.stages.scene?.enabled === false) return;
        const indices = catchUpIndices(chat, before, current);
        if (!indices.length) return;
        for (const index of indices) scheduler.start(index);
        await scheduler.flush(indices.at(-1), current.observeWaitMs);
    }

    async function plan(coreChat, contextSize, rawType) {
        const type = rawType || 'normal';
        const current = settings();
        if (type === 'quiet') return;
        if (!current.enabled) {
            suppression.clear();
            clearBrief();
            return;
        }
        if (type === 'continue') return;

        planController?.abort();
        const controller = new AbortController();
        planController = controller;
        suppression.clear();
        clearBrief();
        const started = now();
        const chatId = deps.getChatId();
        const chat = deps.getChat();
        // A swipe replaces the last AI message, so its state must not feed the new reply.
        const before = type === 'swipe' && isAiMessage(chat[chat.length - 1]) ? chat.length - 1 : chat.length;

        await ensureObserved(chat, before, current);
        const { state } = readState(chat, { before });
        const result = await runPhase(stages, {
            phase: 'plan',
            turn: { chat: coreChat, contextSize, type, signal: controller.signal, ctx: deps.getContextView(), settings: current },
            state,
            settings: current,
            budgetMs: Math.max(0, current.planBudgetMs - (now() - started)),
            now,
        });
        if (planController === controller) planController = null;
        if (deps.getChatId() !== chatId) {
            suppression.clear();
            clearBrief();
            return;
        }

        const brief = result.outputs.brief?.brief ?? '';
        const briefTokens = brief ? await deps.countTokens(brief) : 0;
        const ms = now() - started;
        const droppedTokens = result.outputs.lore?.droppedTokens ?? 0;
        session.lastPlan = { at: now(), type, ms, reports: result.reports, brief, briefTokens, droppedTokens };
        recordPlan(session.stats, { ms, reports: result.reports, briefTokens, droppedTokens });
        alert(result.reports);
        deps.onUpdate();
    }

    function onMessageReceived(mesId, type) {
        const current = settings();
        if (!current.enabled || current.observeTrigger !== 'settled' || type === 'quiet' || type === 'impersonate') return;
        const id = Number(mesId);
        if (isAiMessage(deps.getChat()[id])) scheduler.schedule(id, current.settleMs);
    }

    function onMessageEdited(mesId) {
        const current = settings();
        if (!current.enabled || current.observeTrigger !== 'settled') return;
        const chat = deps.getChat();
        const id = Number(mesId);
        const target = isAiMessage(chat[id]) ? id : chat[id]?.is_user && isAiMessage(chat[id + 1]) ? id + 1 : -1;
        if (target >= 0) scheduler.schedule(target, current.settleMs);
    }

    function onMessageSwiped(mesId) {
        scheduler.cancel(Number(mesId));
        deps.onUpdate();
    }

    function onMessageDeleted() {
        scheduler.cancelAll();
        deps.onUpdate();
    }

    // The last message is about to change (new swipe, regenerated, or continued), so an observe of
    // its current text would be wasted.
    function onGenerationStarted(type, _options, dryRun) {
        if (dryRun || !['swipe', 'regenerate', 'continue'].includes(type)) return;
        scheduler.cancel(deps.getChat().length - 1);
    }

    function onGenerationStopped() {
        planController?.abort();
        suppression.clear();
    }

    function onGenerationEnded() {
        suppression.clear();
    }

    function onChatChanged() {
        planController?.abort();
        scheduler.cancelAll();
        suppression.clear();
        clearBrief();
        session.lastPlan = null;
        session.lastObserve = null;
        deps.onUpdate();
    }

    const onWorldInfoLoaded = (data) => applySuppression(data, suppression);

    function currentView() {
        const chat = deps.getChat();
        const index = latestAiIndex(chat);
        const own = index >= 0 ? chat[index].extra?.conductor ?? null : null;
        const { state, record, index: stateIndex } = readState(chat);
        return {
            chatId: deps.getChatId(), index, stateIndex, state,
            textHash: index >= 0 ? observeInput(chat, index, settings()).textHash : null,
            provenance: record?.provenance ?? {},
            stale: Boolean(own?.stale),
            observed: Boolean(own?.state),
            pending: index >= 0 && scheduler.isPending(index),
        };
    }

    /**
     * Saves a manual edit onto the latest AI message. `expected` ({ chatId, index, textHash } from the
     * view the edit started from) refuses the save if the chat, the latest message, or that message's
     * text (swipe, regenerate, edit) changed since. The record is stamped with the message's current
     * text hash, so Plan treats it as current and never re-extracts over the edit.
     */
    async function setState(raw, expected = {}) {
        const checked = validateState(raw, { threadsCap: settings().stages.scene.threadsCap });
        if (!checked.ok) return { ok: false, error: checked.error };
        const chat = deps.getChat();
        const index = latestAiIndex(chat);
        if (index < 0) return { ok: false, error: 'no character message to attach the scene to yet' };
        if ('chatId' in expected && expected.chatId !== deps.getChatId()) {
            return { ok: false, error: 'the chat changed since you started editing, so the edit was not saved' };
        }
        if ('index' in expected && expected.index !== index) {
            return { ok: false, error: 'a newer message arrived since you started editing, so the edit was not saved' };
        }
        const { textHash } = observeInput(chat, index, settings());
        if ('textHash' in expected && expected.textHash !== textHash) {
            return { ok: false, error: 'the message changed since you started editing (swiped, regenerated or edited), so the edit was not saved' };
        }
        scheduler.cancel(index); // an extraction in flight must not overwrite the edit
        const { state: prev, record } = readState(chat);
        const provenance = { ...(record?.provenance ?? {}) };
        for (const path of diffPaths(prev, checked.state)) provenance[path] = { mesId: null, quote: null, manual: true };
        writeRecord(chat[index], makeRecord({
            state: checked.state, provenance, source: 'manual', textHash,
        }));
        await deps.saveChat();
        deps.onUpdate();
        return { ok: true, state: checked.state };
    }

    async function editField(path, value) {
        if (latestAiIndex(deps.getChat()) < 0) return { ok: false, error: 'no character message to attach the scene to yet' };
        const edit = applyFieldEdit(currentView().state, path, value);
        return edit.ok ? setState(edit.state) : edit;
    }

    async function retry() {
        const index = latestAiIndex(deps.getChat());
        if (index < 0) return;
        scheduler.cancel(index);
        await scheduler.start(index);
    }

    function statusText() {
        const lines = [`sangkhem is ${settings().enabled ? 'on' : 'off'}.`];
        if (session.lastPlan) {
            lines.push(`Last plan (${session.lastPlan.ms} ms): ${session.lastPlan.reports.map((r) => `${r.id} ${r.status}`).join(', ')}`);
        }
        const view = currentView();
        lines.push(view.stale ? 'Scene: out of date (last extraction failed).' : view.observed ? 'Scene: up to date.' : 'Scene: not tracked yet.');
        return lines.join('\n');
    }

    return {
        plan, observe, clearBrief, currentView, setState, editField, retry, statusText, session,
        onMessageReceived, onMessageEdited, onMessageSwiped, onMessageDeleted,
        onGenerationStarted, onGenerationStopped, onGenerationEnded, onChatChanged, onWorldInfoLoaded,
    };
}
