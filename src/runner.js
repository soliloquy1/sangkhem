export const DEFAULT_STAGE_TIMEOUT_MS = 10000;

export class StageTimeoutError extends Error {
    constructor(ms) {
        super(`timed out after ${ms} ms`);
        this.name = 'StageTimeoutError';
    }
}

export class StageAbortedError extends Error {
    constructor() {
        super('aborted');
        this.name = 'StageAbortedError';
    }
}

/**
 * Runs task(signal) with a timeout. The signal aborts on timeout or when parentSignal aborts.
 * @param {(signal: AbortSignal) => any} task
 * @param {number} ms
 * @param {AbortSignal} [parentSignal]
 */
export function runWithTimeout(task, ms, parentSignal) {
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
        let timer = null;
        const cleanup = () => {
            if (timer !== null) clearTimeout(timer);
            parentSignal?.removeEventListener('abort', onParentAbort);
        };
        function onParentAbort() {
            controller.abort();
            cleanup();
            reject(new StageAbortedError());
        }
        if (parentSignal?.aborted) {
            reject(new StageAbortedError());
            return;
        }
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });
        if (Number.isFinite(ms)) {
            timer = setTimeout(() => {
                controller.abort();
                cleanup();
                reject(new StageTimeoutError(ms));
            }, ms);
        }
        Promise.resolve()
            .then(() => task(controller.signal))
            .then(
                (value) => { cleanup(); resolve(value); },
                (error) => { cleanup(); reject(error); },
            );
    });
}

function availability(stage, ctx, config) {
    try {
        return stage.available ? stage.available(ctx, config) : true;
    } catch (error) {
        return `availability check failed: ${error.message}`;
    }
}

/**
 * Status of a stage for the settings panel.
 * @returns {{ id: string, status: 'off'|'ready'|'unavailable', reason?: string }}
 */
export function describeStage(stage, settings, ctx) {
    const config = settings?.stages?.[stage.id] ?? {};
    if (config.enabled === false) return { id: stage.id, status: 'off' };
    const result = availability(stage, ctx, config);
    if (result === true) return { id: stage.id, status: 'ready' };
    return { id: stage.id, status: 'unavailable', reason: typeof result === 'string' ? result : 'unavailable' };
}

/**
 * Runs every stage of one phase in order. Never throws: failures become reports.
 * A stage with `budgetExempt: true` still runs after the budget is used up (cheap stages only).
 * @returns {Promise<{ outputs: object, state: object, reports: object[] }>}
 */
export async function runPhase(stages, { phase, turn, state, settings, budgetMs = Infinity, now = Date.now }) {
    const started = now();
    const outputs = {};
    const reports = [];
    let current = state;
    for (const stage of stages.filter((s) => s.phase === phase)) {
        const config = settings?.stages?.[stage.id] ?? {};
        const skip = (reason, ms = 0) => reports.push({ id: stage.id, status: 'skipped', ms, reason });
        if (config.enabled === false) {
            reports.push({ id: stage.id, status: 'off', ms: 0 });
            continue;
        }
        if (turn.signal?.aborted) {
            skip('aborted');
            continue;
        }
        const remaining = budgetMs - (now() - started);
        const exempt = stage.budgetExempt === true;
        if (remaining <= 0 && !exempt) {
            skip('plan budget used up');
            continue;
        }
        const available = availability(stage, turn.ctx, config);
        if (available !== true) {
            skip(typeof available === 'string' ? available : 'unavailable');
            continue;
        }
        const ownTimeout = config.timeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
        // A timeout shortened by the budget is the budget's fault, not the stage's: report a skip.
        const clipped = !exempt && remaining < ownTimeout;
        const timeoutMs = exempt ? ownTimeout : Math.min(ownTimeout, remaining);
        const t0 = now();
        try {
            const result = (await runWithTimeout(
                (signal) => stage.run({ ...turn, outputs, signal }, current, config),
                timeoutMs,
                turn.signal,
            )) ?? {};
            const ms = now() - t0;
            if (result.skip) {
                skip(result.skip, ms);
                continue;
            }
            if ('output' in result) outputs[stage.id] = result.output;
            if (result.statePatch) current = { ...current, ...result.statePatch };
            reports.push({ id: stage.id, status: 'ran', ms, summary: result.summary });
        } catch (error) {
            if (error instanceof StageAbortedError) skip('aborted', now() - t0);
            else if (error instanceof StageTimeoutError && clipped) skip('plan budget used up', now() - t0);
            else reports.push({ id: stage.id, status: 'failed', ms: now() - t0, reason: error?.message ?? String(error) });
        }
    }
    return { outputs, state: current, reports };
}

/** Counts consecutive failures per stage so the UI can warn once, not every turn. */
export class FailureTracker {
    constructor() {
        this.streaks = new Map();
    }

    /** @returns {string[]} ids of stages whose failure streak just reached threshold */
    record(reports, threshold) {
        const alerts = [];
        for (const { id, status } of reports) {
            if (status === 'failed') {
                const count = (this.streaks.get(id) ?? 0) + 1;
                this.streaks.set(id, count);
                if (count === threshold) alerts.push(id);
            } else if (status === 'ran') {
                this.streaks.set(id, 0);
            }
        }
        return alerts;
    }
}
