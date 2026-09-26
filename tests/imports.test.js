import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
// The only files allowed to touch SillyTavern or the DOM.
const ST_FILES = new Set([
    'index.js', 'src/st.js', 'src/commands.js',
    'src/ui/dom.js', 'src/ui/panel.js', 'src/ui/settingsForm.js', 'src/ui/scenePanel.js', 'src/ui/inspector.js',
]);

function jsFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? jsFiles(path) : path.endsWith('.js') ? [path] : [];
    });
}

const sources = jsFiles(join(root, 'src')).map((path) => relative(root, path));

test('logic modules never reference SillyTavern or browser globals', () => {
    const offenders = sources
        .filter((file) => !ST_FILES.has(file))
        .filter((file) => /\b(SillyTavern|document|window|toastr|jQuery)\b/.test(readFileSync(join(root, file), 'utf8')));
    assert.deepEqual(offenders, []);
});

test('every src module imports in plain Node', async () => {
    for (const file of sources) {
        await import(join(root, file));
    }
});
