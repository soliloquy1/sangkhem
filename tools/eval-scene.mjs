#!/usr/bin/env node
// Measures scene extraction for one model against tools/fixtures/scene. Uses the extension's own
// scene settings (including its pinned temperature) so it measures what the extension sends.
// Reports change recall (did the model catch what changed) and stability (did it leave the rest
// alone). A call that errors counts as failing every check.
// Usage: EVAL_API_KEY=... node tools/eval-scene.mjs --url https://openrouter.ai/api/v1 --model google/gemini-2.5-flash
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createSceneStage } from '../src/stages/scene.js';
import { validateState } from '../src/state.js';
import { mergeDefaults } from '../src/settings.js';
import { scoreFixture, summarize } from './eval-score.mjs';

const { values } = parseArgs({
    options: {
        url: { type: 'string' },
        model: { type: 'string' },
        fixtures: { type: 'string', default: fileURLToPath(new URL('./fixtures/scene/', import.meta.url)) },
        'max-tokens': { type: 'string', default: '800' },
    },
});
if (!values.url || !values.model) {
    console.error('Usage: EVAL_API_KEY=... node tools/eval-scene.mjs --url <OpenAI-compatible base URL> --model <model id>');
    process.exit(2);
}

const llm = {
    async complete(_profileId, messages, { maxTokens, temperature, signal }) {
        const response = await fetch(`${values.url.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(process.env.EVAL_API_KEY ? { Authorization: `Bearer ${process.env.EVAL_API_KEY}` } : {}),
            },
            body: JSON.stringify({ model: values.model, messages, max_tokens: maxTokens, temperature }),
            signal,
        });
        if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
        const data = await response.json();
        return data.choices?.[0]?.message?.content ?? '';
    },
};

const config = { ...mergeDefaults({}).stages.scene, profileId: 'eval', maxTokens: Number(values['max-tokens']) };
const stage = createSceneStage({ llm });
const files = (await readdir(values.fixtures)).filter((f) => f.endsWith('.json')).sort();
const results = [];
let rejections = 0;

for (const file of files) {
    const fixture = JSON.parse(await readFile(join(values.fixtures, file), 'utf8'));
    const prev = validateState(fixture.prev ?? {}).state;
    let state = prev;
    let rejected = [];
    let error = null;
    try {
        const result = await stage.run({
            mesId: 0, userText: fixture.user, replyText: fixture.reply,
            userName: fixture.userName, charName: fixture.charName, prevProvenance: {},
            signal: AbortSignal.timeout(60000),
        }, prev, config);
        state = result.statePatch ?? prev;
        rejected = result.output?.rejected ?? [];
    } catch (e) {
        error = e.message;
    }
    const scored = scoreFixture(fixture.expected, state, prev);
    const checks = error ? scored.map((c) => ({ ...c, ok: false })) : scored;
    rejections += rejected.length;
    results.push({ name: fixture.name, checks });
    const passed = checks.filter((c) => c.ok).length;
    console.log(`${passed === checks.length ? 'PASS' : 'FAIL'} ${fixture.name} (${passed}/${checks.length})${error ? ` error: ${error}` : ''}`);
    for (const check of checks) if (!check.ok) console.log(`    wrong: ${check.field}${check.changed ? ' (missed change)' : ' (changed something that should stay)'}`);
    for (const r of rejected) console.log(`    gate rejected ${r.path}: ${r.reason}`);
}

const summary = summarize(results);
const pct = (value) => `${((value ?? 0) * 100).toFixed(1)}%`;
console.log(`\nChange recall: ${pct(summary.recall)} of ${summary.changes} expected changes. Stability: ${pct(summary.stability)}. ${rejections} gate rejection(s).`);
for (const [field, s] of Object.entries(summary.byField)) console.log(`  ${field}: ${s.ok}/${s.total}`);
process.exitCode = (summary.recall ?? 0) >= 0.9 && (summary.stability ?? 0) >= 0.9 ? 0 : 1;
