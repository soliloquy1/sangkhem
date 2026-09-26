/** Thrown by a backend whose service cannot be reached; stages turn it into a skip, not a failure. */
export class BackendUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BackendUnavailableError';
    }
}

/**
 * Picks the configured backend, or `backends.none` when it is unknown or unavailable.
 * @returns {{ backend: object, reason: string|null }}
 */
export function resolveBackend(backends, id, ctx) {
    const chosen = backends[id];
    if (!chosen) return { backend: backends.none, reason: `unknown backend "${id}"` };
    const availability = chosen.available(ctx);
    if (availability === true) return { backend: chosen, reason: null };
    return { backend: backends.none, reason: typeof availability === 'string' ? availability : `${id} unavailable` };
}
