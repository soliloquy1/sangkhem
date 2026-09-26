import { BackendUnavailableError } from '../resolve.js';

// How long to treat the service as down after a connection error before trying again.
export const DOWN_RETRY_MS = 60000;
export const HEALTH_TIMEOUT_MS = 3000;

const trimUrl = (url) => String(url ?? '').replace(/\/+$/, '');

/** Scores lore entries with the local Laya service (POST /wi-director, GET /health). */
export function createLayaScorer({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
    let downUntil = 0;
    return {
        id: 'laya',
        label: 'Laya',
        available() {
            if (now() < downUntil) return `Laya service unreachable; retrying in ${Math.ceil((downUntil - now()) / 1000)} s`;
            return true;
        },
        async score(candidates, context, { serviceUrl, signal } = {}) {
            let response;
            try {
                response = await fetchImpl(`${trimUrl(serviceUrl)}/wi-director`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: context.message, recent_turns: context.recent, candidates }),
                    signal,
                });
            } catch (error) {
                if (signal?.aborted) throw error;
                downUntil = now() + DOWN_RETRY_MS;
                throw new BackendUnavailableError(`Laya service unreachable at ${serviceUrl}`);
            }
            if (!response.ok) throw new Error(`Laya service returned ${response.status}`);
            const data = await response.json();
            downUntil = 0;
            return (data?.results ?? [])
                .filter((r) => typeof r?.id === 'string')
                .map((r) => ({ id: r.id, relevance: Number(r.relevance) || 0, usefulness: Number(r.usefulness) || 0 }));
        },
        async health(serviceUrl) {
            try {
                const response = await fetchImpl(`${trimUrl(serviceUrl)}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
                if (response.ok) downUntil = 0;
                return response.ok;
            } catch {
                return false;
            }
        },
    };
}
