import { LOG_PREFIX } from './src/settings.js';
import * as st from './src/st.js';
import { createLlm } from './src/llm.js';
import { createConductor } from './src/conductor.js';
import { createMemoryStage } from './src/stages/memory.js';
import { createLoreStage } from './src/stages/lore.js';
import { createBriefStage } from './src/stages/brief.js';
import { createSceneStage } from './src/stages/scene.js';
import { createLayaScorer } from './src/backends/scorers/laya.js';
import { noneScorer } from './src/backends/scorers/none.js';
import { initPanel, refreshPanel } from './src/ui/panel.js';
import { registerCommands } from './src/commands.js';

const suppression = new Set();
const briefStore = { value: '' };
const laya = createLayaScorer();

const stages = [
    createMemoryStage(),
    createLoreStage({
        scorers: { laya, none: noneScorer },
        scanWorldInfo: st.scanWorldInfo,
        countTokens: st.countTokens,
        includeNames: st.worldInfoIncludeNames,
        suppression,
    }),
    createBriefStage({ briefStore, setPrompt: st.setBriefPrompt }),
    createSceneStage({ llm: createLlm(st.sendLlmRequest) }),
];

const conductor = createConductor({
    stages,
    suppression,
    briefStore,
    deps: {
        getSettings: st.getSettings,
        getChat: st.getChat,
        getChatId: st.getChatId,
        getContextView: st.getContextView,
        names: st.names,
        saveChat: st.saveChat,
        setBriefPrompt: st.setBriefPrompt,
        countTokens: st.countTokens,
        // `reason` can carry model or proxy text, so the toast is always escaped.
        notify: (id, reason, count) => toastr.warning(
            `The ${id} stage failed ${count} turns in a row (${reason}). Replies still generate without it.`,
            'sangkhem', { escapeHtml: true }),
        onUpdate: () => refreshPanel(),
        log: (error) => console.error(`${LOG_PREFIX} observe failed`, error),
    },
});

// Runs before ST's real World Info scan. Must never throw: generation continues regardless.
globalThis.conductorInterceptor = async function (chat, contextSize, _abort, type) {
    try {
        await conductor.plan(chat, contextSize, type);
    } catch (error) {
        suppression.clear();
        console.error(`${LOG_PREFIX} plan failed; generation continues unchanged`, error);
    }
};

// The conductor's handlers are synchronous (Observe runs on its own timer), so ST's awaited
// event chain is never held up. A handler error is logged, never thrown into ST.
function safe(name, fn) {
    return (...args) => {
        try {
            fn(...args);
        } catch (error) {
            console.error(`${LOG_PREFIX} ${name} handler failed`, error);
        }
    };
}

function registerEvents() {
    const { eventSource, eventTypes } = st.ctx();
    eventSource.on(eventTypes.MESSAGE_RECEIVED, safe('MESSAGE_RECEIVED', conductor.onMessageReceived));
    eventSource.on(eventTypes.MESSAGE_EDITED, safe('MESSAGE_EDITED', conductor.onMessageEdited));
    eventSource.on(eventTypes.MESSAGE_SWIPED, safe('MESSAGE_SWIPED', conductor.onMessageSwiped));
    eventSource.on(eventTypes.MESSAGE_DELETED, safe('MESSAGE_DELETED', conductor.onMessageDeleted));
    eventSource.on(eventTypes.GENERATION_STARTED, safe('GENERATION_STARTED', conductor.onGenerationStarted));
    eventSource.on(eventTypes.GENERATION_STOPPED, safe('GENERATION_STOPPED', conductor.onGenerationStopped));
    eventSource.on(eventTypes.GENERATION_ENDED, safe('GENERATION_ENDED', conductor.onGenerationEnded));
    eventSource.on(eventTypes.CHAT_CHANGED, safe('CHAT_CHANGED', conductor.onChatChanged));
    eventSource.on(eventTypes.WORLDINFO_ENTRIES_LOADED, safe('WORLDINFO_ENTRIES_LOADED', conductor.onWorldInfoLoaded));
}

jQuery(async () => {
    st.initSettings();
    st.registerBriefMacro(briefStore);
    registerEvents();
    registerCommands({ conductor, refresh: refreshPanel });
    await initPanel({ conductor, stages, laya });
});
