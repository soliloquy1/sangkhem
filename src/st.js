// The SillyTavern adapter. Everything else is plain logic, testable in Node.
// Nothing here may touch SillyTavern at import time.
import { MODULE_NAME, mergeDefaults } from './settings.js';

export const ctx = () => SillyTavern.getContext();

// extension_prompt_types.IN_CHAT and extension_prompt_roles.SYSTEM in public/script.js.
const IN_CHAT = 1;
const SYSTEM_ROLE = 0;

export function initSettings() {
    const root = ctx().extensionSettings;
    root[MODULE_NAME] = mergeDefaults(root[MODULE_NAME]);
    return root[MODULE_NAME];
}

export const getSettings = () => ctx().extensionSettings[MODULE_NAME];
export const saveSettings = () => ctx().saveSettingsDebounced();
export const getChat = () => ctx().chat;
export const getChatId = () => ctx().getCurrentChatId?.();
export const saveChat = () => ctx().saveChat();

export function getContextView() {
    const c = ctx();
    return {
        extensionSettings: c.extensionSettings,
        chatMetadata: c.chatMetadata,
        disabledExtensions: c.extensionSettings?.disabledExtensions ?? [],
    };
}

export function names() {
    const c = ctx();
    return { userName: c.name1 || 'User', charName: c.name2 || 'Character' };
}

export function setBriefPrompt(text, depth) {
    ctx().setExtensionPrompt(MODULE_NAME, text, IN_CHAT, depth, false, SYSTEM_ROLE);
}

export async function countTokens(text) {
    try {
        return await ctx().getTokenCountAsync(text);
    } catch {
        return Math.ceil(String(text ?? '').length / 4);
    }
}

let worldInfoModule;
async function worldInfo() {
    worldInfoModule ??= await import('../../../../world-info.js');
    return worldInfoModule;
}

/** Dry-run World Info scan with ST's own matcher. */
export async function scanWorldInfo(chatForWI, contextSize) {
    const scan = await (await worldInfo()).checkWorldInfo(chatForWI, contextSize, true);
    return Array.from(scan?.allActivatedEntries?.values?.() ?? []);
}

/** ST's World Info "Include names" setting, so the dry run scans the same text as the real scan. */
export async function worldInfoIncludeNames() {
    return Boolean((await worldInfo()).world_info_include_names);
}

// The profile's sampler preset is not applied (includePreset: false) and the temperature is sent
// explicitly, so the extension runs the same settings tools/eval-scene.mjs measures.
export function sendLlmRequest(profileId, messages, { maxTokens, temperature, signal }) {
    return ctx().ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        { stream: false, signal, extractData: true, includePreset: false, includeInstruct: true },
        temperature === undefined ? {} : { temperature },
    );
}

export function listProfiles() {
    try {
        return ctx().ConnectionManagerRequestService.getSupportedProfiles().map((p) => ({ id: p.id, name: p.name }));
    } catch {
        return [];
    }
}

// Registers {{conductor_brief}} in both macro engines. The legacy registry serves SillyTavern's default
// engine and bridges into the new engine itself when that engine is on at startup; registering in the new
// engine as well covers a user who turns it on later.
export function registerBriefMacro(briefStore) {
    const c = ctx();
    const handler = () => briefStore.value;
    const description = 'sangkhem scene notes for this turn';
    c.registerMacro('conductor_brief', handler, description);
    if (c.macros?.register && !c.macros.registry?.hasMacro?.('conductor_brief')) {
        c.macros.register('conductor_brief', { description, handler });
    }
}

export function presetPromptTexts() {
    const prompts = ctx().chatCompletionSettings?.prompts;
    return Array.isArray(prompts) ? prompts.map((p) => p?.content) : [];
}

export const currentSource = () => ctx().chatCompletionSettings?.chat_completion_source ?? '';

export function currentModel() {
    try {
        return ctx().getChatCompletionModel() ?? '';
    } catch {
        return '';
    }
}
