import { validateState, FIELDS } from '../state.js';
import { applyEvidenceGate } from '../evidence.js';
import { parseJsonReply } from '../llm.js';

const FIELD_HELP = {
    location: '"location": where the scene takes place.',
    time: '"time": time of day, date, weather, or other timing that matters.',
    present: '"present": everyone physically in the scene, including {user}. Each entry is {"name", "outfit", "condition", "mood"}; "condition" covers injuries, exhaustion, intoxication and similar physical states.',
    threads: '"threads": open plot threads, promises and unresolved questions, one short phrase each, at most {cap}. Keep the existing order, add new ones at the end, and remove ones that are resolved.',
};

const PATH_HELP = {
    location: '"location"',
    time: '"time"',
    present: '"present.<Name>" (someone arrived or left), "present.<Name>.outfit", "present.<Name>.condition", "present.<Name>.mood"',
    threads: '"threads.<thread text>" (a thread was opened or resolved)',
};

export const enabledFields = (fields = {}) => FIELDS.filter((field) => fields?.[field] !== false);

/** The state with only enabled fields, for showing to the model. */
export function projectState(state, fields) {
    return Object.fromEntries(enabledFields(fields).map((field) => [field, state[field]]));
}

export function buildScenePrompt({ prev, userText, replyText, userName, charName, fields, threadsCap }) {
    const on = enabledFields(fields);
    const system = [
        'You track the scene of an ongoing roleplay. Read the previous scene state and the two newest messages, then return the updated scene state.',
        '',
        'State fields:',
        ...on.map((field) => `- ${FIELD_HELP[field].replace('{user}', userName).replace('{cap}', String(threadsCap))}`),
        '',
        'Rules:',
        '- Change a field only when the new messages show that it changed. Otherwise copy it exactly from the previous state.',
        '- For every change, add an entry to "evidence". The key is the field path; the value is a short quote copied word for word from one of the two messages that shows the change.',
        `- Field paths: ${on.map((field) => PATH_HELP[field]).join(', ')}.`,
        '- A change without an exact quote is thrown away, so do not guess.',
        '- Reply with JSON only, in this shape: {"state": {...}, "evidence": {"<field path>": "<exact quote>"}}',
    ].join('\n');
    const user = [
        'Previous scene state:',
        JSON.stringify(projectState(prev, fields), null, 2),
        '',
        `${userName}'s message:`,
        '"""',
        userText?.trim() || '(none)',
        '"""',
        '',
        `${charName}'s reply:`,
        '"""',
        replyText.trim(),
        '"""',
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function keepDisabledFields(next, prev, fields) {
    const out = { ...next };
    for (const field of FIELDS) if (fields?.[field] === false) out[field] = structuredClone(prev[field]);
    return out;
}

/** @param {{ llm: { complete: Function } }} deps */
export function createSceneStage({ llm }) {
    return {
        id: 'scene',
        phase: 'observe',
        available(_ctx, config) {
            return config.profileId ? true : 'choose a connection profile for scene tracking';
        },
        async run(turn, state, config) {
            if (!turn.replyText?.trim()) return { skip: 'reply has no story text' };
            const messages = buildScenePrompt({
                prev: state, userText: turn.userText, replyText: turn.replyText,
                userName: turn.userName, charName: turn.charName, fields: config.fields, threadsCap: config.threadsCap,
            });
            const text = await llm.complete(config.profileId, messages, {
                maxTokens: config.maxTokens, temperature: config.temperature, signal: turn.signal,
            });
            const parsed = parseJsonReply(text);
            const rawState = parsed && typeof parsed.state === 'object' ? parsed.state : parsed;
            // The thread cap is applied once, in the gate, so refusals are visible.
            const checked = validateState(rawState, { threadsCap: Infinity });
            if (!checked.ok) throw new Error(`invalid scene state: ${checked.error}`);
            const next = keepDisabledFields(checked.state, state, config.fields);
            const gate = applyEvidenceGate({
                prev: state, next, evidence: parsed?.evidence, sources: [turn.userText, turn.replyText],
                mesId: turn.mesId, prevProvenance: turn.prevProvenance ?? {}, threadsCap: config.threadsCap,
            });
            return {
                statePatch: gate.state,
                output: { provenance: gate.provenance, accepted: gate.accepted, rejected: gate.rejected, warnings: checked.warnings },
                summary: `${gate.accepted.length} change(s) accepted, ${gate.rejected.length} rejected`,
            };
        },
    };
}
