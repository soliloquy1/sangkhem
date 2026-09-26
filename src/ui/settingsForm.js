import { getPath, setPath } from '../settings.js';
import { getSettings, saveSettings, listProfiles } from '../st.js';

/** Loads settings.html (a static file shipped with the extension) into ST's extensions panel. */
export async function mountSettings() {
    const html = await (await fetch(new URL('../../settings.html', import.meta.url))).text();
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    const root = template.content.firstElementChild;
    (document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings')).append(root);
    return root;
}

function readInput(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') {
        const n = Number(el.value);
        return el.value !== '' && Number.isFinite(n) ? n : null;
    }
    return el.value;
}

function writeInput(el, value) {
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';
}

export function bindSettings(root, onChange) {
    for (const el of root.querySelectorAll('[data-sk-setting]')) {
        writeInput(el, getPath(getSettings(), el.dataset.skSetting));
        el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
            const value = readInput(el);
            if (value === null) return;
            setPath(getSettings(), el.dataset.skSetting, value);
            saveSettings();
            onChange();
        });
    }
}

export function fillProfiles(root) {
    const select = root.querySelector('[data-sk-setting="stages.scene.profileId"]');
    const current = getSettings().stages.scene.profileId;
    const options = [['', '(choose a profile)'], ...listProfiles().map((p) => [p.id, p.name])];
    if (current && !options.some(([id]) => id === current)) options.push([current, '(missing profile)']);
    select.replaceChildren(...options.map(([id, name]) => {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        return option;
    }));
    select.value = current;
}
