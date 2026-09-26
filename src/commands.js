import { ctx, getSettings, saveSettings } from './st.js';
import { parseSceneSet } from './state.js';
import { renderSceneLines } from './stages/brief.js';

const sceneText = (state) => renderSceneLines(state).join('\n') || 'No scene state yet.';

export function registerCommands({ conductor, refresh }) {
    const c = ctx();
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'conductor',
        helpString: 'sangkhem: <code>/conductor on</code>, <code>/conductor off</code>, or <code>/conductor status</code> (default).',
        returns: 'status text',
        unnamedArgumentList: [
            c.SlashCommandArgument.fromProps({
                description: 'on, off, or status',
                typeList: [c.ARGUMENT_TYPE.STRING],
                enumList: ['on', 'off', 'status'],
                defaultValue: 'status',
            }),
        ],
        callback: (_named, value) => {
            const arg = String(value || 'status').trim().toLowerCase();
            if (arg === 'on' || arg === 'off') {
                getSettings().enabled = arg === 'on';
                if (arg === 'off') conductor.clearBrief();
                saveSettings();
                refresh();
            } else if (arg !== 'status') {
                toastr.warning(`Unknown /conductor argument "${arg}". Use on, off, or status.`, 'sangkhem', { escapeHtml: true });
            }
            const text = conductor.statusText();
            toastr.info(text.replaceAll('\n', '<br>'), 'sangkhem', { escapeHtml: false });
            return text;
        },
    }));
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'scene',
        helpString: 'sangkhem scene state. <code>/scene</code> prints it. <code>/scene set location=rooftop</code> edits it. '
            + 'Paths: location, time, threads (separate with ;), present.&lt;Name&gt;.outfit|condition|mood, present.&lt;Name&gt;= (empty removes).',
        returns: 'scene state text',
        unnamedArgumentList: [
            c.SlashCommandArgument.fromProps({
                description: 'empty, or: set <path>=<value>',
                typeList: [c.ARGUMENT_TYPE.STRING],
                defaultValue: '',
            }),
        ],
        callback: async (_named, value) => {
            const arg = String(value ?? '').trim();
            if (/^set\s/i.test(arg)) {
                const parsed = parseSceneSet(arg.replace(/^set\s+/i, ''));
                if (!parsed) {
                    toastr.warning('Use /scene set <path>=<value>, for example /scene set location=rooftop.', 'sangkhem');
                    return '';
                }
                const result = await conductor.editField(parsed.path, parsed.value);
                if (!result.ok) {
                    toastr.warning(result.error, 'sangkhem', { escapeHtml: true });
                    return '';
                }
            } else if (arg) {
                toastr.warning('Use /scene, or /scene set <path>=<value>.', 'sangkhem');
                return '';
            }
            return sceneText(conductor.currentView().state);
        },
    }));
}
