import { h } from './dom.js';
import { briefDoubleWarning, cacheHint } from './format.js';
import { describeStage } from '../runner.js';
import { summarizeStats } from '../stats.js';
import { getSettings, getContextView, presetPromptTexts, currentSource, currentModel } from '../st.js';
import { mountSettings, bindSettings, fillProfiles } from './settingsForm.js';
import { renderScenePanel } from './scenePanel.js';
import { renderInspector } from './inspector.js';
import { applyDraftChanges } from './draft.js';

let root = null;
let deps = null;
let sceneDirty = false;
let draftKey = null; // chat, message and message text the open draft belongs to

const viewKey = (view) => `${view.chatId}:${view.index}:${view.textHash}`;

export async function initPanel(options) {
    deps = options;
    root = await mountSettings();
    fillProfiles(root);
    bindSettings(root, refreshPanel);
    root.querySelector('[data-sk-setting="stages.scene.profileId"]').addEventListener('focus', () => fillProfiles(root));
    root.querySelector('#sangkhem-lore-test').addEventListener('click', async () => {
        const reachable = await deps.laya.health(getSettings().stages.lore.serviceUrl);
        if (reachable) toastr.success('Laya service is reachable.', 'sangkhem');
        else toastr.error('Could not reach the Laya service. Is it running?', 'sangkhem');
        refreshPanel();
    });
    refreshPanel();
}

function renderScene(view = deps.conductor.currentView()) {
    draftKey = viewKey(view);
    renderScenePanel(root.querySelector('#sangkhem-scene-panel'), {
        view,
        fields: getSettings().stages.scene.fields,
        onDirty: () => { sceneDirty = true; },
        onSave: async (draft) => {
            if (!sceneDirty) return; // nothing edited: saving would only freeze extraction for this message
            // Apply only the user's own changes onto the latest state, so an extraction that finished
            // while the draft was open is not reverted.
            const merged = applyDraftChanges(view.state, draft, deps.conductor.currentView().state);
            if (!merged.ok) {
                toastr.warning(merged.error, 'sangkhem', { escapeHtml: true });
                return;
            }
            const result = await deps.conductor.setState(merged.state, { chatId: view.chatId, index: view.index, textHash: view.textHash });
            if (!result.ok) {
                toastr.warning(result.error, 'sangkhem', { escapeHtml: true });
                return;
            }
            sceneDirty = false;
            renderScene();
        },
        onRevert: () => { sceneDirty = false; renderScene(); },
        onRetry: () => deps.conductor.retry(),
        onJump: (mesId) => document.querySelector(`#chat .mes[mesid="${Number(mesId)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    });
}

export function refreshPanel() {
    if (!root) return;
    try {
        const settings = getSettings();
        const ctx = getContextView();
        const statuses = deps.stages.map((stage) => describeStage(stage, settings, ctx));
        root.querySelector('#sangkhem-stage-status').replaceChildren(...statuses.map((s) => h('div', {
            class: `sk-status sk-${s.status}`, text: `${s.id}: ${s.status}${s.reason ? ` — ${s.reason}` : ''}`,
        })));
        const warnings = [
            briefDoubleWarning(settings.stages.brief.mode, presetPromptTexts()),
            cacheHint({ source: currentSource(), model: currentModel(), protectCachePrefix: settings.stages.lore.protectCachePrefix }),
        ].filter(Boolean);
        root.querySelector('#sangkhem-warnings').replaceChildren(...warnings.map((text) => h('div', { class: 'sk-warning', text })));
        renderInspector(root.querySelector('#sangkhem-inspector'), deps.conductor.session, summarizeStats(deps.conductor.session.stats));
        const view = deps.conductor.currentView();
        // A draft for another chat or an older message is dropped rather than saved onto this one.
        if (sceneDirty && draftKey !== viewKey(view)) sceneDirty = false;
        if (!sceneDirty) renderScene(view);
    } catch (error) {
        console.error('[sangkhem] panel refresh failed', error);
    }
}
