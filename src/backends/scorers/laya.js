import { BackendUnavailableError } from '../resolve.js';

// How long to treat the service as down after a connection error before trying again.
export const DOWN_RETRY_MS = 60000;
export const HEALTH_TIMEOUT_MS = 3000;

const trimUrl = (url) => String(url ?? '').replace(/\/+$/, '');

/**
 * Scores lore entries with the local Laya service (POST /wi-director, GET /health).
 * The service counts as unavailable until it has answered once: the first availability check starts
 * a /health probe in the background, so users without the service never pay for a dry-run scan or a
 * refused request. A changed service URL is checked again.
 */
export function createLayaScorer({
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = Date.now,
    getServiceUrl = () => 'http://localhost:8666',
} = {}) {
    let status = 'unknown'; // 'unknown' | 'checking' | 'up' | 'down'
    let checkedUrl = null;
    let downUntil = 0;
    const markUp = (url) => { status = 'up'; checkedUrl = url; downUntil = 0; };
    const markDown = (url) => { status = 'down'; checkedUrl = url; downUntil = now() + DOWN_RETRY_MS; };

    async function health(serviceUrl) {
        const url = trimUrl(serviceUrl);
        try {
            const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
            if (response.ok) markUp(url);
            else markDown(url);
            return response.ok;
        } catch {
            markDown(url);
            return false;
        }
    }

    return {
        id: 'laya',
        label: 'Laya',
        available() {
            const url = trimUrl(getServiceUrl());
            if (url !== checkedUrl && status !== 'checking') status = 'unknown';
            if (status === 'up') return true;
            if (status === 'down' && now() < downUntil) {
                return `Laya service unreachable at ${url}; retrying in ${Math.ceil((downUntil - now()) / 1000)} s`;
            }
            if (status !== 'checking') {
                status = 'checking';
                checkedUrl = url;
                void health(url);
            }
            return `checking the Laya service at ${url}`;
        },
        async score(candidates, context, { serviceUrl, signal } = {}) {
            const url = trimUrl(serviceUrl);
            let response;
            try {
                response = await fetchImpl(`${url}/wi-director`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: context.message, recent_turns: context.recent, candidates }),
                    signal,
                });
            } catch (error) {
                if (signal?.aborted) throw error;
                markDown(url);
                throw new BackendUnavailableError(`Laya service unreachable at ${serviceUrl}`);
            }
            markUp(url); // it answered, even if with an error
            if (!response.ok) throw new Error(`Laya service returned ${response.status}`);
            const data = await response.json();
            return (data?.results ?? [])
                .filter((r) => typeof r?.id === 'string')
                .map((r) => ({ id: r.id, relevance: Number(r.relevance) || 0, usefulness: Number(r.usefulness) || 0 }));
        },
        health,
    };
}
