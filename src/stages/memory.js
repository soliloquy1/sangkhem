import { resolveBackend } from '../backends/resolve.js';
import { summaryceptionMemory } from '../backends/memory/summaryception.js';
import { noneMemory } from '../backends/memory/none.js';

export const MEMORY_BACKENDS = { summaryception: summaryceptionMemory, none: noneMemory };

export function createMemoryStage({ backends = MEMORY_BACKENDS } = {}) {
    return {
        id: 'memory',
        phase: 'plan',
        available(ctx, config) {
            const { backend, reason } = resolveBackend(backends, config.backend, ctx);
            return backend.id === 'none' ? (reason ?? 'memory source is set to none') : true;
        },
        async run(turn, _state, config) {
            const { backend } = resolveBackend(backends, config.backend, turn.ctx);
            const summary = backend.getSummary(turn.ctx);
            if (!summary) return { skip: `${backend.label} has no readable summary` };
            return { output: { summary, source: backend.id }, summary: `${backend.label}, ${summary.length} chars` };
        },
    };
}
